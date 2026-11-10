import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequesterAccountProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { StoredCredentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { ResolveExternalActionEncryption } from '../externalActions/executeExternalAction';
import type { RequesterEnvironmentAccessObservation } from '@/api/client/accountEncryptionCurrentnessObservation';

export type RetainedRequesterAccountCustody = Readonly<{
  isCurrent(): Promise<boolean>;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  refreshAccountSettings(signal?: AbortSignal): Promise<boolean>;
  retainCustody(signal?: AbortSignal): RetainedRequesterAccountCustody;
  release(): Promise<void>;
}>;

/** Finite Account custody at an admitted ingress, never a Session or a credential store. */
export type RequesterAccountActionContext = Readonly<{
  invocation?: ExternalActionRequesterInvocationV1;
  /** Host-local retained controller packet; never serialized as Action input or a new credential. */
  deploymentChildExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
  deploymentChild?: import('@happier-dev/protocol').DeploymentChildRpcV1;
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  accountSettingsContext: AccountSettingsContext;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  authorization: ExternalActionExecutionAuthorizationV1;
  serverHttpBaseUrl: string;
  resolveEncryption: ResolveExternalActionEncryption;
  isCurrent(): Promise<boolean>;
  /** Local installed custody, separate from fresh Home effect authorization. */
  isCustodyCurrent?: () => Promise<boolean>;
  refreshAccountSettings(signal?: AbortSignal): Promise<boolean>;
  /** Existing requester Account/Home feed; invalidation only, never an access grant. */
  subscribeEnvironmentAccess(listener: (event: RequesterEnvironmentAccessObservation) => void): () => void;
  /** Retained relationship custody needs an installed lifetime owner independent of finite ingress. */
  retainCustody?: (signal?: AbortSignal) => RetainedRequesterAccountCustody;
  /** An admitted operation replaces its transport lifetime without spending a new Home admission. */
  retainForOperation?: (signal: AbortSignal) => Promise<Readonly<{
    authorization: ExternalActionExecutionAuthorizationV1;
    dispose(): Promise<void>;
  }>>;
  retain(): () => Promise<void>;
  dispose(): Promise<void>;
}>;

export const requesterActionContext = Symbol('admittedRequesterAccountActionContext');

/** Enumerable only for host-local object spread; HTTP header enumeration omits Symbols. */
export const requesterAccountEncryptionMode = Symbol('admittedRequesterAccountEncryptionMode');
export type RequesterAccountAuthorizationHeaders = Readonly<Record<string, string>> & Readonly<{
  [requesterAccountEncryptionMode]?: 'plain' | 'e2ee';
}>;

/** Host-local custody facet; strict parsing/JSON forwarding cannot carry credentials or settings. */
export function readRequesterAccountActionContext(authorization?: ExternalActionExecutionAuthorizationV1): RequesterAccountActionContext | null {
  const projection: (ExternalActionRequesterAccountProjectionV1 & { [requesterActionContext]?: RequesterAccountActionContext }) | undefined
    = authorization?.requesterAccountProjection;
  return projection?.[requesterActionContext] ?? null;
}

/** Select private author custody once; a signed requester cannot inherit the daemon Account. */
export function resolveRequesterSavedSecretActionCustody(input: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  credentials: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
}>): Readonly<{ credentials: StoredCredentials; operation: SavedSecretOperationContextV1 | undefined }> {
  const operation = readRequesterAccountActionContext(input.authorization)?.savedSecretOperationContext
    ?? (input.authorization ? undefined : input.operationContext);
  if (input.authorization && !operation) throw Object.assign(new Error('Saved Secret requester custody is unavailable'), {
    code: 'client_required',
  });
  return { credentials: operation?.credentials ?? input.credentials, operation };
}

/** Keep admitted custody when its owner enriches the same signed root. */
export function rebindRequesterAccountActionContext(
  authorization: ExternalActionExecutionAuthorizationV1,
  previous: ExternalActionExecutionAuthorizationV1,
  retainedContext?: RequesterAccountActionContext,
): ExternalActionExecutionAuthorizationV1 {
  const context = retainedContext ?? readRequesterAccountActionContext(previous);
  if (!context) return authorization;
  const source = retainedContext ? authorization.requesterAccountProjection! : previous.requesterAccountProjection!;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  Reflect.deleteProperty(descriptors, requesterActionContext);
  const projection = Object.defineProperties({ ...source }, descriptors);
  const carrier: ExternalActionExecutionAuthorizationV1 = Object.defineProperties({ ...authorization }, {
    ...Object.getOwnPropertyDescriptors(authorization),
    requesterAccountProjection: { value: projection, enumerable: false },
  });
  Object.defineProperty(projection, requesterActionContext, {
    value: Object.freeze({ ...context, authorization: carrier }), enumerable: false,
  });
  Object.freeze(projection);
  return Object.freeze(carrier);
}
