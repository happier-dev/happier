import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionApiTokenContentAccessV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

const tokenContentAccess = Symbol('sameTokenContentAccess');
type Custody = Readonly<{ contentPublicKey: string; wrappingSecret: Uint8Array }>;
type Authorization = ExternalActionExecutionAuthorizationV1 & { [tokenContentAccess]?: Custody };

/** The strict encrypted opener is the sole producer; custody ends with that invocation. */
export function retainApiTokenDeploymentContentAccess(authorization: ExternalActionExecutionAuthorizationV1,
  access: ExternalActionApiTokenContentAccessV2): () => void {
  const root = authorization.binding;
  if (!('credentialId' in root) || root.accountEncryptionMode !== 'e2ee'
    || root.sessionActionOrigin || root.workflowActionOrigin) {
    throw Object.assign(new Error('invalid_encrypted_envelope'), { code: 'invalid_encrypted_envelope' });
  }
  const wrappingSecret = decodeBase64(access.wrappingSecret, 'base64url');
  let live = true;
  const custody = { contentPublicKey: access.contentPublicKey, wrappingSecret };
  Object.defineProperty(authorization, tokenContentAccess, { get: () => live ? custody : null,
    enumerable: false });
  return () => { live = false; wrappingSecret.fill(0); };
}

export function readApiTokenDeploymentContentAccess(authorization: ExternalActionExecutionAuthorizationV1): Custody | null {
  return (authorization as Authorization)[tokenContentAccess] ?? null;
}

/**
 * One public refusal when an end-to-end encrypted Account's content-consuming root
 * carries no same-token encryption access: a plain hap_v1 bearer, or a sealed request
 * without content access. It names the missing credential, never Account content.
 */
export function apiTokenEncryptionAccessRequired() {
  return { ok: false as const, errorCode: 'client_required', effectAttempted: false,
    error: 'This Home uses end-to-end encryption, and this API token has no encryption access.',
    details: { requiredFact: 'api_token_encryption_access',
      remedy: 'Create an API token with encryption access and use that credential as HAPPIER_TOKEN.' } };
}
