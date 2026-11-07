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
