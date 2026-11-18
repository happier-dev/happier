import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readRetainedVerifiedExternalActionRequester, retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequesterAccountProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionRequesterAccountContextPurposeV1, ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { StoredCredentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createRequesterAccountSettingsPublication } from '@/settings/accountSettings/requesterAccountSettingsPublication';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import type { ResolveExternalActionEncryption } from '../externalActions/executeExternalAction';
import type { RequesterEnvironmentAccessObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import type { ExecutionRunNativeOfferedModelReader } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

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
  /** Invocation-local native catalog admission; never serialized or retained as Run custody. */
  readNativeOfferedModel?: ExecutionRunNativeOfferedModelReader;
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

/** Session issuers already own Account custody without an ingress settings lifetime. */
export type RequesterAccountActionTransportContext = Pick<RequesterAccountActionContext,
  'authorization' | 'credentials' | 'isCurrent' | 'resolveEncryption'>;

function readRequesterAccountCarrierContext(authorization?: ExternalActionExecutionAuthorizationV1):
  RequesterAccountActionContext | RequesterAccountActionTransportContext | null {
  const projection: (ExternalActionRequesterAccountProjectionV1 & {
    [requesterActionContext]?: RequesterAccountActionContext | RequesterAccountActionTransportContext;
  }) | undefined = authorization?.requesterAccountProjection;
  return projection?.[requesterActionContext] ?? null;
}

/** Both issuer and installed ingress expose the same admitted transport custody. */
export function readRequesterAccountActionTransportContext(authorization?: ExternalActionExecutionAuthorizationV1):
  RequesterAccountActionTransportContext | null {
  return readRequesterAccountCarrierContext(authorization);
}

/** Enumerable only for host-local object spread; HTTP header enumeration omits Symbols. */
export const requesterAccountEncryptionMode = Symbol('admittedRequesterAccountEncryptionMode');
export type RequesterAccountAuthorizationHeaders = Readonly<Record<string, string>> & Readonly<{
  [requesterAccountEncryptionMode]?: 'plain' | 'e2ee';
}>;

/** Host-local custody facet; strict parsing/JSON forwarding cannot carry credentials or settings. */
export function readRequesterAccountActionContext(authorization?: ExternalActionExecutionAuthorizationV1): RequesterAccountActionContext | null {
  const context = readRequesterAccountCarrierContext(authorization);
  return context && 'savedSecretOperationContext' in context ? context : null;
}

/** Select private author custody once; a signed requester cannot inherit the daemon Account. */
export function resolveRequesterSavedSecretActionCustody(input: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  credentials: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
}>): Readonly<{ credentials: StoredCredentials; operation: SavedSecretOperationContextV1 | undefined }> {
  const operation = readRequesterAccountActionContext(input.authorization)?.savedSecretOperationContext
    ?? (input.authorization ? undefined : input.operationContext);
  if (input.authorization && !operation) throw Object.assign(createActionExecuteFailureError({ ok: false,
    errorCode: 'client_required', error: 'client_required' }), { message: 'Saved Secret requester custody is unavailable' });
  return { credentials: operation?.credentials ?? input.credentials, operation };
}

/** Keep admitted custody when its owner enriches the same signed root. */
export function rebindRequesterAccountActionContext(
  authorization: ExternalActionExecutionAuthorizationV1,
  previous: ExternalActionExecutionAuthorizationV1,
  retainedContext?: RequesterAccountActionContext,
): ExternalActionExecutionAuthorizationV1 {
  const context = retainedContext ?? readRequesterAccountCarrierContext(previous);
  if (!context) return authorization;
  const source = retainedContext ? authorization.requesterAccountProjection! : previous.requesterAccountProjection!;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  Reflect.deleteProperty(descriptors, requesterActionContext);
  const projection = Object.defineProperties({ ...source }, descriptors);
  const carrier: ExternalActionExecutionAuthorizationV1 = Object.defineProperties({ ...authorization }, {
    ...Object.getOwnPropertyDescriptors(authorization),
    requesterAccountProjection: { value: projection, enumerable: false },
  });
  const verifiedRequester = readRetainedVerifiedExternalActionRequester(previous);
  // Enriching private Account ports keeps the admitted root's proof. A copied
  // descriptor, a different token or a changed signed binding cannot confer it.
  const bound = verifiedRequester && authorization.token === previous.token
    && sameStrictJsonValue(authorization.binding, previous.binding)
    ? retainVerifiedExternalActionRequester({ authorization: carrier, isCurrent: verifiedRequester.isCurrent })
    : carrier;
  Object.defineProperty(projection, requesterActionContext, {
    value: Object.freeze({ ...context, authorization: bound }), enumerable: false,
  });
  Object.freeze(projection);
  return Object.freeze(bound);
}

export function createRequesterEncryptionResolver(credentials: StoredCredentials, serverIdentityId: string,
  isCurrent: () => Promise<boolean>): ResolveExternalActionEncryption {
  return async signal => {
    if (signal?.aborted || !await isCurrent() || !credentials.encryption) return null;
    const encryption = credentials.encryption;
    return { serverIdentityId, material: encryption.type === 'legacy'
      ? { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(encryption.secret) }
      : encryption };
  };
}

/** Both ingress owners construct the same private Account facet from their admitted facts.
 * The supplying owner keeps its existing observation/publication retirement. */
export function createAdmittedRequesterAccountActionContext(params: Readonly<{
  input: Readonly<{
    credentials: StoredCredentials;
    serverIdentityId: string;
    serverHttpBaseUrl: string;
    isCurrent(): Promise<boolean>;
    isCustodyCurrent?: () => Promise<boolean>;
    isRetainedCustodyCurrent?: () => Promise<boolean>;
    purpose?: ExternalActionRequesterAccountContextPurposeV1;
    invocation?: ExternalActionRequesterInvocationV1;
    deploymentChildExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
    deploymentChild?: import('@happier-dev/protocol').DeploymentChildRpcV1;
  }>;
  authorization: ExternalActionExecutionAuthorizationV1;
  currentness: AccountEncryptionCurrentnessResponse;
  accountSettingsContext: AccountSettingsContext;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  settingsPublication: ReturnType<typeof createRequesterAccountSettingsPublication>;
  observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness>;
  onRetire(): Promise<void>;
}>): RequesterAccountActionContext {
  const { input, authorization, currentness, accountSettingsContext, savedSecretOperationContext,
    settingsPublication, observation } = params;
  const sourcePreparation = input.purpose?.kind === 'workspace_sync_prepare' && input.isCustodyCurrent !== undefined;
  let live = true;
  let references = 1;
  let ingressReleased = false;
  const release = async () => { if (--references === 0) { live = false; await params.onRetire(); } };
  const retain = () => {
    if (!live) throw new Error('requester_account_context_retired');
    references += 1;
    let released = false;
    return async () => { if (!released) { released = true; await release(); } };
  };
  const refreshAccountSettings = settingsPublication.ensureCurrent;
  const resolveEncryption = createRequesterEncryptionResolver(input.credentials, input.serverIdentityId,
    authorization.requesterAccountProjection!.isCurrent);
  const retainCustodyFrom = (source: SavedSecretOperationContextV1): (signal?: AbortSignal) => RetainedRequesterAccountCustody => (signal?: AbortSignal) => {
    const isInstalledCurrent = input.isRetainedCustodyCurrent!;
    const snapshot = source.readSnapshot();
    if (!snapshot) throw new Error('requester_account_context_retired');
    const releaseReference = retain();
    let retained = true;
    const isRetainedCurrent = async () => retained && live && !signal?.aborted && await isInstalledCurrent()
      && retained && live && !signal?.aborted && observation.isCurrent(currentness);
    const retainedSecrets = createInvocationSavedSecretOperationContextV1({
      credentials: input.credentials, snapshot, serverHttpBaseUrl: input.serverHttpBaseUrl,
      machineAdmission: source.machineAdmission, isCurrent: isRetainedCurrent,
    });
    const retainedPublication = createRequesterAccountSettingsPublication({
      observation: observation, currentness, operationContext: retainedSecrets,
    });
    return Object.freeze({
      isCurrent: isRetainedCurrent,
      savedSecretOperationContext: retainedSecrets,
      refreshAccountSettings: retainedPublication.ensureCurrent,
      retainCustody: retainCustodyFrom(retainedSecrets),
      release: async () => { if (retained) { retained = false; retainedPublication.dispose();
        try { await retainedSecrets.isCurrent(); } finally { await releaseReference(); } } },
    });
  };
  // HTTP projection retains this exact private Account facet. Its symbol is
  // not an authorization input and never enters the public carrier schema.
  const projectionDescriptors = Object.getOwnPropertyDescriptors(authorization.requesterAccountProjection!);
  Reflect.deleteProperty(projectionDescriptors, requesterActionContext);
  const projection = Object.defineProperties({ ...authorization.requesterAccountProjection! }, projectionDescriptors);
  const carrier: ExternalActionExecutionAuthorizationV1 = Object.defineProperties({ ...authorization }, {
    ...Object.getOwnPropertyDescriptors(authorization),
    requesterAccountProjection: { value: projection, enumerable: false },
  });
  const context: RequesterAccountActionContext = Object.freeze({ credentials: input.credentials, accountEncryptionCurrentness: currentness, accountSettingsContext, savedSecretOperationContext,
    ...(input.deploymentChildExecution ? { deploymentChildExecution: input.deploymentChildExecution } : {}),
    ...(input.deploymentChild ? { deploymentChild: input.deploymentChild } : {}),
    ...(input.invocation ? { invocation: input.invocation } : {}),
    authorization: carrier, resolveEncryption,
    refreshAccountSettings,
    subscribeEnvironmentAccess: observation.subscribeEnvironmentAccess,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    // input.isCurrent spent Home admission above. Finite work keeps installed
    // custody; only a forwarded receiver retains its own child proof.
    isCurrent: input.purpose?.kind === 'machine_rpc' && input.purpose.recipient
      ? async () => await authorization.requesterAccountProjection!.isCurrent()
        && await input.isCurrent() && await authorization.requesterAccountProjection!.isCurrent()
      : authorization.requesterAccountProjection!.isCurrent,
    ...(input.isCustodyCurrent && !sourcePreparation ? { isCustodyCurrent: authorization.requesterAccountProjection!.isCurrent } : {}),
    ...(input.isRetainedCustodyCurrent ? { retainCustody: retainCustodyFrom(savedSecretOperationContext) } : {}),
    retain,
    dispose: async () => { if (!ingressReleased) { ingressReleased = true; await release(); } },
  });
  Object.defineProperty(projection, requesterActionContext, { value: context, enumerable: false });
  Object.freeze(projection);
  Object.freeze(carrier);
  return context;
}
