import { SignedIdAlias } from "$generated/internet_identity_types";
import {
  CredentialSpec,
  IssuedCredentialData,
} from "$generated/vc_issuer_types";
import { handleLogin } from "$src/components/authenticateBox";
import { withLoader } from "$src/components/loader";
import { showMessage } from "$src/components/message";
import { showSpinner } from "$src/components/spinner";
import { fetchDelegation } from "$src/flows/authorize/fetchDelegation";
import { AuthenticatedConnection, Connection } from "$src/utils/iiConnection";
import {
  Delegation,
  DelegationChain,
  DelegationIdentity,
  ECDSAKeyIdentity,
} from "@dfinity/identity";
import { isNullish, nonNullish } from "@dfinity/utils";
import { base64url } from "jose";
import { abortedCredentials } from "./abortedCredentials";
import { allowCredentials } from "./allowCredentials";
import { VcVerifiablePresentation, vcProtocol } from "./postMessageInterface";
import { VcIssuer } from "./vcIssuer";

// The "verifiable credentials" approval flow
export const vcFlow = async ({
  connection,
}: {
  connection: Connection;
}): Promise<never> => {
  const result = await vcProtocol({
    /* Show some spinners while we wait for more data or for an action to complete */
    onProgress: (x) => {
      if (x === "waiting") {
        return showSpinner({
          message: "Waiting for verification data",
        });
      }

      if (x === "verifying") {
        return showSpinner({
          message: "Checking verification data",
        });
      }
      x satisfies never;
    },

    /* How the credentials are actually verified */
    verifyCredentials: (args) => verifyCredentials({ connection, ...args }),
  });

  if (result === "orphan") {
    await showMessage({
      message: "No credentials data provided! Wrong URL?",
    });
  }

  return await new Promise((_) => {
    /* halt forever */
  });
};

type VerifyCredentials = Parameters<typeof vcProtocol>[0]["verifyCredentials"];
type VerifyCredentialsArgs = Parameters<VerifyCredentials>[0];

const verifyCredentials = async ({
  connection,
  request: {
    credentialSubject: givenP_RP,
    issuer: { origin: issuerOrigin, canisterId: expectedIssuerCanisterId_ },
    credentialSpec,
  },
  rpOrigin,
}: { connection: Connection } & VerifyCredentialsArgs) => {
  // Look up the canister ID from the origin
  const lookedUp = await withLoader(() =>
    lookupCanister({ origin: issuerOrigin })
  );
  if (lookedUp === "not_found") {
    return abortedCredentials({ reason: "no_canister_id" });
  }
  const issuerCanisterId = lookedUp.ok;

  // If the RP provided a canister ID, check that it matches what we got
  if (nonNullish(expectedIssuerCanisterId_)) {
    const expectedCanisterId = expectedIssuerCanisterId_?.toText();
    if (expectedCanisterId !== issuerCanisterId) {
      return abortedCredentials({ reason: "bad_canister_id" });
    }
  }

  const vcIssuer = new VcIssuer(issuerCanisterId);
  // XXX: We don't check that the language matches the user's language. We need
  // to figure what to do UX-wise first.
  const consentInfo = await vcIssuer.getConsentMessage({ credentialSpec });

  if (consentInfo === "error") {
    return abortedCredentials({ reason: "auth_failed_issuer" });
  }

  // Ask user to confirm the verification of credentials
  const allowed = await allowCredentials({
    relyingOrigin: rpOrigin,
    providerOrigin: issuerOrigin,
    consentMessage: consentInfo.consent_message,
    userNumber: undefined,
  });
  if (allowed.tag === "canceled") {
    return "aborted";
  }
  allowed.tag satisfies "allowed";

  const userNumber = allowed.userNumber;

  // For the rest of the flow we need to be authenticated, so authenticate
  // XXX: this simply breaks for PIN identities
  const authResult = await withLoader(() =>
    handleLogin({
      login: () => connection.login(userNumber),
    })
  );

  if (authResult.tag !== "ok") {
    return abortedCredentials({ reason: "auth_failed_ii" });
  }
  const authenticatedConnection = authResult.connection;

  // Compute the user's principal on the RP and ensure it matches what the RP sent us
  const computedP_RP = await withLoader(() =>
    authenticatedConnection.getPrincipal({
      origin: rpOrigin,
    })
  );
  if (computedP_RP.compareTo(givenP_RP) !== "eq") {
    console.error("Principal did not match that expected by RP");
    return abortedCredentials({ reason: "bad_principal_rp" });
  }

  // Ask II to generate the aliases

  const pAliasPending = getAliasCredentials({
    rpOrigin,
    issuerOrigin,
    authenticatedConnection,
  });

  // Grab the credentials from the issuer
  const credentials = await withLoader(async () => {
    const pAliasRes = await pAliasPending;

    if ("err" in pAliasRes) {
      return { err: pAliasRes.err };
    }

    const pAlias = pAliasRes.ok;

    const issuedCredential = await issueCredential({
      vcIssuer,
      issuerOrigin,
      issuerAliasCredential: pAlias.issuerAliasCredential,
      credentialSpec,
      authenticatedConnection,
    });

    if ("err" in issuedCredential) {
      return { err: issuedCredential.err };
    }
    return [issuedCredential.ok, pAlias] as const;
  });

  if ("err" in credentials) {
    return abortedCredentials({ reason: credentials.err });
  }

  const [issuedCredential, pAlias] = credentials;

  // Create the presentation and return it to the RP
  return createPresentation({
    issuerCanisterId,
    rpAliasCredential: pAlias.rpAliasCredential,
    issuedCredential,
  });
};

// Lookup the canister by performing a request to the origin and check
// if the server (probably BN) set a header to inform us of the canister ID
const lookupCanister = async ({
  origin,
}: {
  origin: string;
}): Promise<{ ok: string } | "not_found"> => {
  const response = await fetch(
    origin,
    // fail on redirects
    {
      redirect: "error",
      method: "HEAD",
      // do not send cookies or other credentials
      credentials: "omit",
    }
  );

  if (response.status !== 200) {
    console.error("Bad response when looking for canister ID", response.status);
    return "not_found";
  }

  const HEADER_NAME = "x-ic-canister-id";
  const canisterId = response.headers.get(HEADER_NAME);

  if (isNullish(canisterId)) {
    console.error(
      `Canister ID header '${HEADER_NAME}' was not set on origin ${origin}`
    );

    return "not_found";
  }

  return { ok: canisterId };
};

// Prepare & get aliases
const getAliasCredentials = async ({
  authenticatedConnection,
  issuerOrigin,
  rpOrigin,
}: {
  issuerOrigin: string;
  rpOrigin: string;
  authenticatedConnection: AuthenticatedConnection;
}): Promise<
  | {
      ok: {
        rpAliasCredential: SignedIdAlias;
        issuerAliasCredential: SignedIdAlias;
      };
    }
  | { err: "internal_error" | "auth_failed_ii" }
> => {
  const preparedIdAlias = await authenticatedConnection.prepareIdAlias({
    issuerOrigin,
    rpOrigin,
  });

  if ("error" in preparedIdAlias) {
    if (preparedIdAlias.error === "internal_error") {
      console.error("Could not prepare ID alias");
      return { err: "internal_error" };
    }

    preparedIdAlias.error satisfies "authentication_failed";
    console.error("Could not prepare ID alias: authentication failed");
    return { err: "auth_failed_ii" };
  }

  const result = await authenticatedConnection.getIdAlias({
    preparedIdAlias,
    issuerOrigin,
    rpOrigin,
  });

  if ("error" in result) {
    if (result.error === "internal_error") {
      console.error("Could not get ID alias");
      return { err: "internal_error" };
    }

    result.error satisfies "authentication_failed";
    console.error("Could not get ID alias: authentication failed");
    return { err: "auth_failed_ii" };
  }

  const {
    rp_id_alias_credential: rpAliasCredential,
    issuer_id_alias_credential: issuerAliasCredential,
  } = result;

  return { ok: { rpAliasCredential, issuerAliasCredential } };
};

// Contact the issuer to issue the credentials
const issueCredential = async ({
  vcIssuer,
  issuerOrigin,
  issuerAliasCredential,
  credentialSpec,
  authenticatedConnection,
}: {
  vcIssuer: VcIssuer;
  issuerOrigin: string;
  issuerAliasCredential: SignedIdAlias;
  credentialSpec: CredentialSpec;
  authenticatedConnection: AuthenticatedConnection;
}): Promise<
  | { ok: IssuedCredentialData }
  | { err: "auth_failed_issuer" | "issuer_api_error" }
> => {
  const issuerIdentityRes = await authenticateForIssuer({
    authenticatedConnection,
    issuerOrigin,
  });

  if ("err" in issuerIdentityRes) {
    return { err: issuerIdentityRes.err };
  }

  const issuerIdentity = issuerIdentityRes.ok;

  const args = {
    signedIdAlias: issuerAliasCredential,
    credentialSpec,
    identity: issuerIdentity,
  };

  const preparedCredential = await vcIssuer.prepareCredential(args);

  if (preparedCredential === "error") {
    return { err: "issuer_api_error" };
  }

  const issuedCredential = await vcIssuer.getCredential({
    ...args,
    preparedCredential,
    identity: issuerIdentity,
  });

  if (issuedCredential === "error") {
    return { err: "issuer_api_error" };
  }

  return { ok: issuedCredential };
};

// Perform an authentication (delegation, etc) of the user to the issuer
// so that we can contact the issuer authenticated as the user
const authenticateForIssuer = async ({
  authenticatedConnection,
  issuerOrigin,
}: {
  authenticatedConnection: AuthenticatedConnection;
  issuerOrigin: string;
}): Promise<{ ok: DelegationIdentity } | { err: "auth_failed_issuer" }> => {
  // This is basically a copy-paste of what we have in the authentication flow

  const tempIdentity: ECDSAKeyIdentity = await ECDSAKeyIdentity.generate({
    extractable: false,
  });
  const delegation = await fetchDelegation({
    connection: authenticatedConnection,
    derivationOrigin: issuerOrigin,
    publicKey: new Uint8Array(tempIdentity.getPublicKey().toDer()),
    maxTimeToLive: BigInt(5 * 60 * 1000_000_000) /* 5 minutes */,
  });

  if ("error" in delegation) {
    console.error("Could not fetch delegation");
    return { err: "auth_failed_issuer" };
  }

  const [userKey, parsed_signed_delegation] = delegation;
  const degs = {
    delegation: new Delegation(
      parsed_signed_delegation.delegation.pubkey,
      parsed_signed_delegation.delegation.expiration,
      parsed_signed_delegation.delegation.targets
    ),
    signature: parsed_signed_delegation.signature,
  };
  const delegations = DelegationChain.fromDelegations(
    [degs],
    Uint8Array.from(userKey)
  );
  return { ok: DelegationIdentity.fromDelegation(tempIdentity, delegations) };
};

// Create the final presentation (to be then returned to the RP)
const createPresentation = ({
  issuerCanisterId,
  rpAliasCredential,
  issuedCredential,
}: {
  issuerCanisterId: string;
  rpAliasCredential: SignedIdAlias;
  issuedCredential: IssuedCredentialData;
}): VcVerifiablePresentation => {
  // The simplest JWT header, with no algorithm specified since we don't sign the payload
  const headerObj = { typ: "JWT", alg: "none" };

  const payloadObj = {
    iss: `did:icp:${issuerCanisterId}` /* JWT Issuer is set to the issuer's canister ID as per spec */,
    vp: {
      "@context": "https://www.w3.org/2018/credentials/v1",
      type: "VerifiablePresentation",
      verifiableCredential: [
        rpAliasCredential.credential_jws satisfies string,
        issuedCredential.vc_jws satisfies string,
      ] /* spec dictates first the alias creds, then the VC */,
    },
  };

  const header = base64url.encode(JSON.stringify(headerObj));
  const payload = base64url.encode(JSON.stringify(payloadObj));

  // NOTE: the JWT is not signed, as per the spec
  const signature = "";

  return { verifiablePresentation: [header, payload, signature].join(".") };
};