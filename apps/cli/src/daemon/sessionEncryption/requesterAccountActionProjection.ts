import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { createActionExecuteFailureError, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import axios from '@/api/client/credentialAxios';
import { AccountApiTokenEncryptionAccessResponseV1Schema,
  ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { openApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { readApiTokenDeploymentContentAccess } from '@/auth/apiTokenDeploymentCustody';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { requesterAccountEncryptionMode, requesterActionContext, rebindRequesterAccountActionContext, createAdmittedRequesterAccountActionContext, createRequesterAccountContextRetiredError, createRequesterEncryptionResolver, type RequesterAccountActionTransportContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema,
  deploymentPreparationOperationForActionV1,
  type ExternalActionExecutionAuthorizationV1,
  type ExternalActionExecutionAuthorizationBindingV1,
  type ExternalActionRequesterAccountProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { acquireRequesterAccountEncryptionCurrentness, readRequesterAccountEncryptionCurrentness, sameRequesterAccountEncryptionCurrentness, isRequesterAccountEncryptionCurrentnessObserved } from '@/api/client/accountEncryptionCurrentnessObservation';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { recordRequesterCurrentnessRefusal, rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";
import { type AdmittedRequesterSessionBootstrap } from "./requesterSessionCredentials";
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, encodeRequesterCredentials, type StoredCredentials } from '@/persistence';
import { fetchAccountProfile } from '@/api/accountProfile';
import { bootstrapAccountSettingsContext } from "@/settings/accountSettings/bootstrapAccountSettingsContext";
import { resolvePublishedMachineEncryptionContext } from '@/api/machine/machineDataEncryptionKey';
import { createAccountScopedCryptoMaterialSnapshotV1, type AccountScopedCryptoMaterial,
  type AccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readSessionActionChildCreationRpcEffectV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationActionIdsV1';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1,
  type ExternalActionRequesterAccountContextPurposeV1,
  type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { PrepareExternalActionRequesterAccountContext } from '../externalActions/executeExternalAction';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createRequesterAccountSettingsPublication } from '@/settings/accountSettings/requesterAccountSettingsPublication';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { decodeBase64 } from '@/api/encryption';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { refuseExternalActionPhase, runTracedExternalActionStage, readSessionInputAdmissionDiagnostic } from '../externalActions/externalActionPhase';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isSessionStopChildRootV1, isSessionStopChildV1, readSessionStopChildTargetV1 } from '@happier-dev/protocol/actions/sessionSections';
import { readDeploymentChildRpcV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { deploymentChildEffectActionIdForRootV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { MachineSetupPlanInputV1Schema, isMachineSetupPlanRpcChildV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { PROJECT_SOURCE_UPDATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { PROJECT_SETUP_SET_ACTION_ID_V1, PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';

/** Captured Account ports, not a private Session birth or an admission grant. */
export type RequesterAccountActionCustody = Readonly<{
  credentials: StoredCredentials;
  attribution: RequesterWorkAttributionV1;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
  getBoundSessionId?(): string | null;
}>;

const requesterDeploymentArtifacts = Symbol('requesterDeploymentArtifacts');
const requesterAccountMaterial = Symbol('requesterAccountMaterial');
type TokenProjection = ExternalActionRequesterAccountProjectionV1 & {
  [requesterDeploymentArtifacts]?: ReturnType<typeof createAccountArtifactStore>;
  [requesterAccountMaterial]?: AccountScopedCryptoMaterialSnapshotV1;
};

/** Exact token content custody uses the incumbent signed HTTP and Artifact codecs.
 * No Account credential, Session bootstrap or general delegation is invented. */
export async function prepareApiTokenDeploymentAccountProjection(authorization: ExternalActionExecutionAuthorizationV1,
  signal?: AbortSignal): Promise<Readonly<{ dispose(): void }> | null> {
  const root = authorization.binding;
  const http = authorization.requesterHttpProjection;
  if (!('credentialId' in root) || root.sessionActionOrigin || root.workflowActionOrigin
    || !http || http.accountId !== root.accountId
    || http.serverIdentityId !== root.serverIdentityId || !root.accountEncryptionMode) return null;
  const mode = root.accountEncryptionMode;
  let live = true;
  let key: Uint8Array | null = null;
  const isCurrent = async () => live && !signal?.aborted && await http.isCurrent();
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    if (!await isCurrent()) throw new Error('action_forbidden');
    const headers = await http.createRequestHeaders({ method, path, ...(body === undefined ? {} : { body }),
      effectActionId: root.actionId, ...(signal ? { signal } : {}) });
    if (!headers) throw new Error('action_forbidden');
    const response = await axios.request<unknown>({ url: `${http.serverHttpBaseUrl}${path}`, method, headers,
      ...(body === undefined ? {} : { data: body }), ...(signal ? { signal } : {}), validateStatus: () => true });
    if (response.status !== 200) throw new Error('action_forbidden');
    return response.data;
  };
  try {
    if (mode === 'e2ee') {
      const access = readApiTokenDeploymentContentAccess(authorization);
      if (!access) return null;
      const wrapped = AccountApiTokenEncryptionAccessResponseV1Schema.parse(await request('POST', ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, {}));
      if (wrapped.accountId !== root.accountId || wrapped.tokenId !== root.credentialId) return null;
      key = openApiTokenEncryptionAccessV1({ context: { accountId: root.accountId, serverIdentityId: root.serverIdentityId,
        tokenId: root.credentialId, contentPublicKey: access.contentPublicKey }, wrappingSecret: access.wrappingSecret,
        encryptionAccess: wrapped.encryptionAccess });
      if (!key) return null;
    }
    const material: AccountScopedCryptoMaterial | null = key ? { type: 'dataKey', machineKey: key } : null;
    const encryption: StoredCredentials['encryption'] = key ? { type: 'dataKey', machineKey: key,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(key).publicKey } : null;
    const { createAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
    const artifacts = createAccountArtifactStore({ accountContent: { accountId: root.accountId, encryption },
      resolveServerFeaturesSnapshot: async () => {
        const path = '/v1/features/authenticated';
        const headers = await http.createRequestHeaders({ method: 'GET', path, effectActionId: root.actionId,
          ...(signal ? { signal } : {}) });
        return fetchServerFeaturesSnapshot({ serverUrl: http.serverHttpBaseUrl, projection: 'authenticated',
          resolveAuthorizationHeaders: request => request.method === 'GET' && request.path === path && headers ? headers : null,
          ...(signal ? { signal } : {}) });
      },
      getAccountEncryptionMode: async () => {
        if (!await isCurrent()) throw new Error('action_forbidden');
        return mode;
      } });
    const projection: TokenProjection = {
      accountId: root.accountId, serverId: http.serverId, accountEncryptionMode: mode, isCurrent,
      projectAccountRowCipher: createProjectAccountRowCipherV1({ mode, material,
        randomBytes: length => new Uint8Array(randomBytes(length)) }),
      readArtifact: async (ref, options) => {
        if (ref.serverId !== root.serverIdentityId && ref.serverId !== http.serverId || !await isCurrent()
          || options?.authorization?.token !== authorization.token
          || !sameStrictJsonValue(options.authorization.binding, root)) return null;
        const artifact = await runWithServerHttpBaseUrl(http.serverHttpBaseUrl, () => artifacts.read(ref.artifactId, {
          includeSharedAudience: false,
          prepareRecipients: root.actionId === PROJECT_SOURCE_UPDATE_ACTION_ID_V1 && options.projectSourceId !== undefined,
          ...(options.projectSourceId ? { projectSourceId: options.projectSourceId } : {}),
          ...(options.projectSourcePatch ? { projectSourcePatch: options.projectSourcePatch } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          authorizationHeaders: async req => {
            const headers = await http.createRequestHeaders({ ...req,
              effectActionId: root.actionId === PROJECT_SETUP_SET_ACTION_ID_V1 ? PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.artifactRead : root.actionId,
              ...(options.signal ? { signal: options.signal } : {}) });
            if (!headers) throw new Error('action_forbidden');
            return { ...headers };
          },
        }));
        return artifact ? { artifactId: artifact.artifactId, header: artifact.header,
          document: { artifactId: artifact.artifactId, header: artifact.header, body: artifact.body, revision: artifact.revision } } : null;
      },
    };
    const snapshot = material && encryption?.type === 'dataKey'
      ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
          dataKeyPublicKey: encryption.publicKey }) : undefined;
    Object.defineProperty(projection, requesterAccountMaterial, { get: () => live ? snapshot : undefined, enumerable: false });
    Object.defineProperty(projection, requesterDeploymentArtifacts, { get: () => live ? artifacts : undefined, enumerable: false });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: Object.freeze(projection), enumerable: false });
    const retainedKey = key;
    key = null;
    return { dispose: () => { live = false; retainedKey?.fill(0);
      if (snapshot?.material.type === 'dataKey') snapshot.material.machineKey.fill(0); } };
  } catch { return null; }
  finally { key?.fill(0); }
}

/** Only an admitted requester projection publishes its captured Account store. */
export function readRequesterDeploymentArtifactStore(authorization?: ExternalActionExecutionAuthorizationV1) {
  return (authorization?.requesterAccountProjection as TokenProjection | undefined)?.[requesterDeploymentArtifacts] ?? null;
}

/** Run content uses admitted requester material, which may belong to the receiver
 * for an ordinary Session. Receiver credentials are never substituted as a fallback. */
export function readRequesterAccountEncryptionMaterialSnapshot(authorization?: ExternalActionExecutionAuthorizationV1) {
  return (authorization?.requesterAccountProjection as TokenProjection | undefined)?.[requesterAccountMaterial] ?? null;
}

export type RequesterAccountActionAuthorizationInput = Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  invocation?: ExternalActionRequesterInvocationV1;
  /** Observed stable identity for the captured custody's exact Home. */
  serverIdentityId: string;
  /** Existing port name; an admitted private bootstrap or qualified ordinary
   * owner supplies the same Account ports without fabricating Session birth. */
  bootstrap: RequesterAccountActionCustody;
  signal?: AbortSignal;
}>;

/** Projects already-admitted custody; it neither mints authority nor reads a global Account snapshot. */
export async function projectRequesterAccountActionAuthorization(
  input: RequesterAccountActionAuthorizationInput,
): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  if (!isRequesterAccountActionAuthorizationBound(input)) return null;
  return await projectAdmittedAccountCustody(input);
}

function isRequesterAccountActionAuthorizationBound(input: RequesterAccountActionAuthorizationInput): boolean {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  const { bootstrap } = input;
  const stamp = bootstrap.attribution;
  const source = parsed.success ? parsed.data.binding.sessionActionSource : undefined;
  const origin = parsed.success ? parsed.data.binding.sessionActionOrigin : undefined;
  const exactSource = source?.machineId === stamp.machineId && source.installationId === stamp.installationId
    && origin?.caller.kind === 'session' && bootstrap.getBoundSessionId?.() === origin.caller.sessionId;
  const handoff = parsed.success ? parsed.data.binding.handoffAdmission : undefined;
  const exactHandoffTarget = parsed.success
    && (parsed.data.binding.handoffContinuation !== undefined || parsed.data.binding.handoffPreflight !== undefined) && handoff !== undefined
    && handoff.targetMachineId === stamp.machineId && handoff.targetInstallationId === stamp.installationId
    && parsed.data.binding.machineId === stamp.machineId && parsed.data.binding.installationId === stamp.installationId
    && bootstrap.getBoundSessionId?.() === handoff.sessionId;
  if (!parsed.success || input.signal?.aborted
    || parsed.data.binding.accountId !== stamp.accountId
    || (source || origin ? !exactSource && !exactHandoffTarget : parsed.data.binding.machineId !== stamp.machineId
      || parsed.data.binding.installationId !== stamp.installationId)
    || parsed.data.binding.serverIdentityId !== input.serverIdentityId) return false;
  return true;
}

/** A handoff capture borrows its bootstrap's already-admitted Account custody. */
export async function projectRequesterSessionCaptureAccountContext(input: RequesterAccountActionAuthorizationInput & Readonly<{
  currentness: AccountEncryptionCurrentnessResponse;
  accountSettingsContext: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  settingsPublication: ReturnType<typeof createRequesterAccountSettingsPublication>;
  observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness>;
}>): Promise<RequesterAccountActionContext | null> {
  if (!isRequesterAccountActionAuthorizationBound(input)) return null;
  const authorization = await projectAdmittedAccountCustody(input, () => true, undefined, input.currentness);
  if (!authorization) return null;
  return createAdmittedRequesterAccountActionContext({ ...input, authorization,
    input: { credentials: input.bootstrap.credentials,
      serverIdentityId: input.serverIdentityId,
      serverHttpBaseUrl: input.bootstrap.serverHttpBaseUrl, isCurrent: () => input.bootstrap.isCurrent(),
      isRetainedCustodyCurrent: () => input.bootstrap.isCurrent() },
    // The bootstrap retires its observation and publication only after the
    // capture releases native and retained Account custody. This facet borrows them.
    onRetire: async () => undefined,
  });
}

/** Both admitted owners use these same Account ports; Session provenance stays in its caller guard. */
async function projectAdmittedAccountCustody(
  input: RequesterAccountActionAuthorizationInput,
  isCustodyLive: () => boolean = () => true,
  isPreparationCurrent = () => input.bootstrap.isCurrent(),
  admittedCurrentness?: AccountEncryptionCurrentnessResponse,
): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  const { bootstrap } = input;
  const stamp = bootstrap.attribution;
  const refused = (phase: string) => { refuseExternalActionPhase(phase, stamp.machineId, undefined, parsed.success ? {
    ...readSessionInputAdmissionDiagnostic(parsed.data.binding), refusalBranch: phase,
  } : undefined); return null; };
  if (!parsed.success) return refused('requester_projection_root');
  let phase = 'requester_projection_currentness';
  try {
    if (!await isPreparationCurrent()) return refused('requester_projection_custody');
    if (input.signal?.aborted) return refused('requester_projection_cancelled');
    const currentness = admittedCurrentness ?? await readRequesterAccountEncryptionCurrentness({ accountId: stamp.accountId, token: bootstrap.credentials.token,
      serverBaseUrl: bootstrap.serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) });
    const encryption = bootstrap.credentials.encryption;
    if (parsed.data.binding.accountEncryptionMode !== undefined
      && parsed.data.binding.accountEncryptionMode !== currentness.mode) return refused('requester_projection_mode');
    if (currentness.mode === 'e2ee' && !encryption) return refused('requester_projection_material');
    if (!await isPreparationCurrent()) return refused('requester_projection_custody');
    if (input.signal?.aborted) return refused('requester_projection_cancelled');
    const material: AccountScopedCryptoMaterial | null = currentness.mode === 'plain' ? null : encryption?.type === 'legacy'
        ? { type: 'legacy', secret: new Uint8Array(encryption.secret) }
        : encryption ? { type: 'dataKey', machineKey: new Uint8Array(encryption.machineKey) } : null;
    phase = 'requester_projection_cipher';
    const cipher = createProjectAccountRowCipherV1({ mode: currentness.mode,
      material,
      randomBytes: length => new Uint8Array(randomBytes(length)) });
    const isCurrent = async (): Promise<boolean> => {
      const diagnose = (phase: 'requester_projection_cancelled' | 'requester_projection_custody'
        | 'requester_projection_observation' | 'requester_projection_encryption_currentness') => {
        recordRequesterCurrentnessRefusal(phase === 'requester_projection_cancelled' ? 'local_abort_signal'
          : phase === 'requester_projection_custody' ? 'installation_custody' : 'observed_account_encryption_currentness');
        if (parsed.data.binding.actionId === 'session.message.send') refused(phase);
      };
      try {
        if (input.signal?.aborted) { diagnose('requester_projection_cancelled'); return false; }
        if (!isCustodyLive()) { diagnose('requester_projection_custody'); return false; }
        const scope = { accountId: stamp.accountId, token: bootstrap.credentials.token,
          serverBaseUrl: bootstrap.serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) };
        const isLocalCustodyCurrent = async () => {
          if (input.signal?.aborted) { diagnose('requester_projection_cancelled'); return false; }
          if (!await bootstrap.isCurrent()) { diagnose('requester_projection_custody'); return false; }
          if (input.signal?.aborted) { diagnose('requester_projection_cancelled'); return false; }
          if (!isCustodyLive()) { diagnose('requester_projection_custody'); return false; }
          return true;
        };
        if (!admittedCurrentness) {
          // The reader fences an exact credential's borrowed observation; an independent
          // Session instead retains its own fresh authenticated HTTP currentness.
          return await readRequesterAccountEncryptionCurrentness(scope, async next => {
            if (!sameRequesterAccountEncryptionCurrentness(next, currentness)) {
              diagnose('requester_projection_encryption_currentness'); return false;
            }
            return await isLocalCustodyCurrent();
          });
        }
        if (!isRequesterAccountEncryptionCurrentnessObserved(scope, currentness)) {
          diagnose('requester_projection_observation'); return false;
        }
        if (!await isLocalCustodyCurrent()) return false;
        const observed = isRequesterAccountEncryptionCurrentnessObserved({ accountId: stamp.accountId,
          token: bootstrap.credentials.token, serverBaseUrl: bootstrap.serverHttpBaseUrl }, currentness);
        if (!observed) diagnose('requester_projection_observation');
        return observed;
      } catch (error) { refuseExternalActionPhase('requester_projection_currentness', stamp.machineId, error, {
        ...readSessionInputAdmissionDiagnostic(parsed.data.binding), refusalBranch: 'exception',
      }); rethrowRequesterHomeReadFailure(error); return recordRequesterCurrentnessRefusal('currentness_exception'); }
    };
    // Loaded only when a real admitted invocation asks for private Account ports.
    phase = 'requester_projection_ports';
    const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
    const artifacts = createCredentialedAccountArtifactStore(bootstrap.credentials);
    const { createProjectSetupTrustRowCipher } = await import('@/workspaces/projectSetup/projectSetupTrust');
    const { createAuthoringMemoryRowCipher } = await import('@/settings/authoringMemory/createAuthoringMemoryClient');
    const { projectAccountArtifactToPromptLibraryStoredArtifact } = await import('@/session/actions/approvals/artifactStore');
    const projection: ExternalActionRequesterAccountProjectionV1 = {
      accountId: stamp.accountId, serverId: stamp.serverId,
      accountEncryptionMode: currentness.mode, projectAccountRowCipher: cipher, isCurrent,
      projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode: currentness.mode, material }),
      authoringMemoryRowCipher: createAuthoringMemoryRowCipher({ accountMode: currentness.mode, material }),
      sealRequesterAccountContext: async request => {
        if (request.authorization.binding.accountId !== stamp.accountId
          || request.authorization.binding.serverIdentityId !== input.serverIdentityId || !await isCurrent()) return null;
        try {
        const sealed = sealExternalActionRequesterAccountContextV1({ ...request,
          ...(input.invocation ? { invocation: input.invocation } : {}),
            credentials: encodeRequesterCredentials(bootstrap.credentials),
            randomBytes: length => new Uint8Array(randomBytes(length)) });
          return await isCurrent() ? sealed : null;
        } catch (error) { refuseExternalActionPhase('requester_custody_seal', stamp.machineId, error); rethrowRequesterHomeReadFailure(error); return null; }
      },
      resolveMachineContentEncryptionContext: row => {
        const context = resolvePublishedMachineEncryptionContext({ credentials: bootstrap.credentials,
          machineId: row.id, expectedAccountMode: row.access?.resourceMode ?? row.storageMode ?? currentness.mode,
          access: row.access, publishedDataEncryptionKey: row.dataEncryptionKey, machineKind: row.kind,
          installationId: row.installationId, runnerContentKeyBinding: row.runnerContentKeyBinding });
        return context.encryptionMode === 'plain' ? { encryptionMode: 'plain' as const }
          : { ...context, encryptionMode: 'e2ee' as const };
      },
      readOwnSessionWorkspace: async request => {
        if (request.machineId !== stamp.machineId || request.signal?.aborted || !await isCurrent()) return null;
        try {
          const { readOwnSessionMachineWorkspace } = await import('@/session/machineControlLocality');
          return await readOwnSessionMachineWorkspace({ ...request, credentials: bootstrap.credentials,
            serverHttpBaseUrl: bootstrap.serverHttpBaseUrl });
        } catch (error) { refuseExternalActionPhase('requester_workspace_read', stamp.machineId, error); rethrowRequesterHomeReadFailure(error); return null; }
      },
      readArtifact: async (ref, options) => {
        if (!await isServerProfileHomeIdentity(stamp.serverId, ref.serverId) || options?.signal?.aborted || !await isCurrent()) return null;
        try {
          const root = parsed.data.binding;
          const appUpdate = root.actionId === 'registries.updates.check' && root.registryAppUpdateAdmission !== undefined;
          const preparation = root.deploymentPreparationAdmission;
          const setup = deploymentPreparationOperationForActionV1(root.actionId) === 'setup' && preparation?.operation === 'setup';
          const sourcePublication = root.actionId === PROJECT_SOURCE_UPDATE_ACTION_ID_V1 && options?.projectSourceId !== undefined;
          const acceptedSetup = root.actionId === PROJECT_SETUP_SET_ACTION_ID_V1;
          const signedDocument = appUpdate || setup || sourcePublication || acceptedSetup;
          const supplied = ExternalActionExecutionAuthorizationV1Schema.safeParse(options?.authorization);
          const http = options?.authorization?.requesterHttpProjection;
          if (signedDocument && (!supplied.success || supplied.data.token !== parsed.data.token || !sameStrictJsonValue(supplied.data.binding, root)
            || !http || http.accountId !== stamp.accountId || http.serverId !== stamp.serverId
            || http.serverIdentityId !== input.serverIdentityId
            || normalizeServerHttpBaseUrl(http.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(bootstrap.serverHttpBaseUrl)
            || !await http.isCurrent())) return null;
          const authorizationHeaders: import('@/api/artifacts/accountArtifactStore').ArtifactRequestAuthorizationHeaders | undefined = signedDocument
            ? async request => {
              const headers = http && await http.createRequestHeaders({ ...request,
                effectActionId: acceptedSetup ? PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.artifactRead : root.actionId,
                ...(options?.signal ? { signal: options.signal } : {}) });
              if (!headers || headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== parsed.data.token)
                throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
              return { ...headers, [requesterAccountEncryptionMode]: currentness.mode };
            } : undefined;
          const artifact = await runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl,
            () => artifacts.read(ref.artifactId, { ...(options?.signal ? { signal: options.signal } : {}), includeSharedAudience: false,
              ...(options?.projectSourceId ? { projectSourceId: options.projectSourceId } : {}),
              ...(options?.projectSourcePatch ? { projectSourcePatch: options.projectSourcePatch } : {}),
              ...(authorizationHeaders ? { authorizationHeaders, prepareRecipients: sourcePublication } : {}) }));
          if (!artifact || artifact.artifactId !== ref.artifactId) return null;
          const promptLibraryArtifact = projectAccountArtifactToPromptLibraryStoredArtifact(artifact);
          return { artifactId: artifact.artifactId, header: artifact.header,
            ...(signedDocument ? { document: { artifactId: artifact.artifactId, header: artifact.header,
              body: artifact.body, revision: artifact.revision } } : {}),
            ...(promptLibraryArtifact ? { promptLibraryArtifact } : {}) };
        } catch (error) { refuseExternalActionPhase('requester_artifact_read', stamp.machineId, error); rethrowRequesterHomeReadFailure(error); return null; }
      },
    };
    // Session custody already owns this material. Keep it host-private, just
    // like its existing ciphers; signed HTTP still owns each resource read.
    Object.defineProperty(projection, requesterAccountMaterial, { enumerable: false,
      value: currentness.mode === 'e2ee' && material
        ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
          ...(encryption?.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) }) : undefined });
    Object.defineProperty(projection, requesterDeploymentArtifacts, { value: artifacts, enumerable: false });
    const carrier: ExternalActionExecutionAuthorizationV1 = { ...parsed.data };
    const requesterHttpProjection = input.authorization.requesterHttpProjection;
    if (requesterHttpProjection) {
      Object.defineProperty(carrier, 'requesterHttpProjection', {
        value: requesterHttpProjection, enumerable: false,
      });
    }
    // Private ports must not enter JSON, signed wire bodies, approval records,
    // logs, or RPC forwarding. Strict wire parsing also drops this local facet.
    Object.defineProperty(carrier, 'requesterAccountProjection', { value: projection, enumerable: false });
    Object.defineProperty(projection, requesterActionContext, { enumerable: false, value: Object.freeze({
      authorization: carrier, credentials: bootstrap.credentials, serverHttpBaseUrl: bootstrap.serverHttpBaseUrl, isCurrent,
      resolveEncryption: createRequesterEncryptionResolver(bootstrap.credentials, input.serverIdentityId, isCurrent),
    } satisfies RequesterAccountActionTransportContext) });
    Object.freeze(projection);
    return Object.freeze(carrier);
  } catch (error) { refuseExternalActionPhase(phase, stamp.machineId, error, {
    ...readSessionInputAdmissionDiagnostic(input.authorization.binding), refusalBranch: 'exception',
  }); rethrowRequesterHomeReadFailure(error); return null; }
}

/** Consumes already-admitted ports at the exact installed receiver; never opens installed credentials. */
export type AdmittedRequesterAccountReadRuntime = Readonly<{
  serverId: string; machineId: string; accountId: string; serverHttpBaseUrl: string;
  accountAuthorization: ExternalActionExecutionAuthorizationV1; isCurrent(): Promise<boolean>;
}>;

/** Structural custody binding; the receiving Home still authorizes each read. */
export function readAdmittedRequesterAccountReadRuntime(input: Readonly<{
  ingress: RpcHandlerContext; serverId: string; machineId: string; installationId: string;
  isInstalledCurrent(): boolean | Promise<boolean>;
}>): AdmittedRequesterAccountReadRuntime | null {
  const { ingress } = input;
  const admission = ingress.machineAdmission;
  const authorization = ingress.callerInputAuthorization;
  const account = authorization?.requesterAccountProjection;
  const http = authorization?.requesterHttpProjection;
  const packet = ingress.workspaceSyncSourceExecution;
  // RpcHandlerManager already matched this signed projection to the decrypted
  // job before opening requester custody. The retained packet keeps E2EE bytes.
  const deploymentChild = packet?.externalActionExecution.deploymentChildRouting;
  const forwardedMove = (authorization?.binding.actionId === 'projects.service.relocate'
    || packet !== undefined && packet.externalActionExecution.effectActionId === readSessionActionChildCreationRpcEffectV1(
      packet.method.slice(packet.method.indexOf(':') + 1), authorization?.binding,
      { machineId: input.machineId, installationId: input.installationId }, packet.externalActionExecution.reviewedChild)
    || isSessionStopChildRootV1(authorization?.binding.actionId)
      && packet?.method === `${input.machineId}:${RPC_METHODS.STOP_SESSION}`
      && isSessionStopChildV1({ rootActionId: authorization.binding.actionId,
        effectActionId: packet.externalActionExecution.effectActionId, method: RPC_METHODS.STOP_SESSION,
        target: packet.externalActionExecution.target, params: packet.params })
    || isMachineSetupPlanRpcChildV1({ rootActionId: authorization?.binding.actionId,
      effectActionId: packet?.externalActionExecution.effectActionId, method: RPC_METHODS.MACHINE_SETUP_PLAN })
      && packet?.method === `${input.machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}` && admission?.role === 'manage'
    || deploymentChild?.machineId === input.machineId && deploymentChild.installationId === input.installationId
      && authorization !== undefined
      && deploymentChild.actionId === deploymentChildEffectActionIdForRootV1(
        authorization.binding.actionId, authorization.binding.deploymentPreparationAdmission, deploymentChild.actionId)
      && packet?.externalActionExecution.effectActionId === deploymentChild.actionId
      && packet.method === `${input.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`) && packet?.originalActionEnvelope
    && ingress.originalActionEnvelope && sameStrictJsonValue(packet.originalActionEnvelope, ingress.originalActionEnvelope)
    && authorization !== undefined && packet.externalActionExecution.authorization.token === authorization.token
    && sameStrictJsonValue(packet.externalActionExecution.authorization.binding, authorization.binding)
    && packet.method.startsWith(`${input.machineId}:`);
  if (!admission || !authorization || !account || !http || !ingress.verifyMachineAdmissionCurrent
    || admission.machineId !== input.machineId || admission.installationId !== input.installationId
    || !forwardedMove && (authorization.binding.machineId !== input.machineId || authorization.binding.installationId !== input.installationId
        || authorization.binding.custodianAccountId !== admission.custodianAccountId)
    || authorization.binding.accountId !== admission.actorAccountId
    || account.accountId !== admission.actorAccountId || http.accountId !== account.accountId
    || account.serverId !== input.serverId || http.serverId !== input.serverId
    || http.serverIdentityId !== authorization.binding.serverIdentityId
    || account.accountEncryptionMode !== authorization.binding.accountEncryptionMode
    || http.accountEncryptionMode !== account.accountEncryptionMode) return null;
  const isCurrent = async () => {
    try { return !ingress.signal.aborted && await input.isInstalledCurrent()
      && await ingress.verifyMachineAdmissionCurrent!() && await account.isCurrent() && await http.isCurrent()
      && !ingress.signal.aborted && await input.isInstalledCurrent(); }
    catch (error) { refuseExternalActionPhase('requester_read_runtime_currentness', input.machineId, error); return false; }
  };
  return { serverId: input.serverId, machineId: input.machineId, accountId: account.accountId,
    accountAuthorization: authorization, serverHttpBaseUrl: http.serverHttpBaseUrl, isCurrent };
}

export async function resolveAdmittedRequesterAccountReadRuntime(input: Parameters<typeof readAdmittedRequesterAccountReadRuntime>[0]): Promise<AdmittedRequesterAccountReadRuntime | null> {
  const runtime = readAdmittedRequesterAccountReadRuntime(input);
  return runtime && await runtime.isCurrent() ? runtime : null;
}

type RequesterAccountActionAdmissionInput = Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  deploymentChildExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
  deploymentChild?: import('@happier-dev/protocol').DeploymentChildRpcV1;
  purpose?: ExternalActionRequesterAccountContextPurposeV1;
  invocation?: ExternalActionRequesterInvocationV1;
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
  /** Supplied by the installed owner after root admission; never a transported fact. */
  isCustodyCurrent?: () => Promise<boolean>;
  /** Installed host lifetime only; excludes finite request cancellation and Home root verification. */
  isRetainedCustodyCurrent?: () => Promise<boolean>;
  /** Transferred only after successful admission; runs at final retained retirement. */
  onRetire?: () => Promise<void>;
  signal?: AbortSignal;
}>;

export async function admitRequesterAccountActionContext(input: RequesterAccountActionAdmissionInput): Promise<RequesterAccountActionContext | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  const refuseAdmission = (phase: string, refusalBranch: string, error?: unknown, observedAccountEncryptionMode?: 'plain' | 'e2ee') => {
    refuseExternalActionPhase(phase, parsed.success ? parsed.data.binding.machineId : 'unavailable', error, parsed.success ? {
      ...readSessionInputAdmissionDiagnostic(parsed.data.binding), observedAccountEncryptionMode, refusalBranch,
    } : undefined); return null;
  };
  if (!parsed.success) return refuseAdmission('requester_admission', 'schema');
  if (parsed.data.binding.serverIdentityId !== input.serverIdentityId) return refuseAdmission('requester_admission', 'home');
  if (input.signal?.aborted) return refuseAdmission('requester_admission', 'cancelled');
  if (!await input.isCurrent()) return refuseAdmission('requester_admission', 'currentness');
  let observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | undefined;
  let admitted = false;
  let live = true;
  let settingsPublication: ReturnType<typeof createRequesterAccountSettingsPublication> | undefined;
  let savedSecrets: SavedSecretOperationContextV1 | undefined;
  const isCurrent = async () => {
    if (!live) return recordRequesterCurrentnessRefusal('installation_custody');
    if (input.signal?.aborted) return recordRequesterCurrentnessRefusal('local_abort_signal');
    if (!await (input.isCustodyCurrent ?? input.isCurrent)()) return recordRequesterCurrentnessRefusal('installation_custody');
    if (!live) return recordRequesterCurrentnessRefusal('installation_custody');
    if (input.signal?.aborted) return recordRequesterCurrentnessRefusal('local_abort_signal');
    return true;
  };
  const sourcePreparation = input.purpose?.kind === 'workspace_sync_prepare' && input.isCustodyCurrent !== undefined;
  // SOURCE constructors consume installed custody, but retained ports and Settings
  // refresh keep the exact signed request's full currentness owner.
  const isProjectionCurrent = sourcePreparation
    ? input.isCurrent
    : isCurrent;
  let phase = 'requester_profile';
  const refused = (branch = phase, observedMode?: 'plain' | 'e2ee') => refuseAdmission(phase, branch, undefined, observedMode);
  try {
    const trace = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(
      parsed.data.binding.actionId, parsed.data.binding.requestId, stage, operation);
    // Admit the requester identity before opening its observation. One witness
    // then supplies both encryption identity and this admission's Settings floor.
    const profile = await trace('requester.profile', () => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () =>
      fetchAccountProfile({ token: input.credentials.token, projection: 'self', ...(input.signal ? { signal: input.signal } : {}) })));
    if (profile.id !== parsed.data.binding.accountId) return refused('profile_identity');
    if (input.signal?.aborted) return refused('cancelled');
    phase = 'requester_encryption_currentness';
    observation = acquireRequesterAccountEncryptionCurrentness({ accountId: parsed.data.binding.accountId,
      token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl });
    const currentness = await trace('requester.encryption_currentness', () => observation!.readWitness(input.signal, { refresh: true }));
    phase = 'requester_account_mode';
    if (parsed.data.binding.accountEncryptionMode !== currentness.mode) return refused('mode', currentness.mode);
    if (currentness.mode === 'plain' ? input.credentials.encryption !== null : input.credentials.encryption === null) return refused('mode_material', currentness.mode);
    if (!await isCurrent()) return refused('custody', currentness.mode);
    phase = 'requester_content_key';
    if (currentness.mode === 'e2ee' && currentness.contentKeyFingerprint && input.credentials.encryption) {
      const encryption = input.credentials.encryption;
      const key = resolveAccountContentSecretKey(encryption);
      if (computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey) !== currentness.contentKeyFingerprint) return refused();
    }
    bindRequesterSessionCredentialScope(input.credentials, { serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl });
    phase = 'requester_settings';
    if (!observation.isCurrent(currentness)) return refused('settings_identity');
    const accountSettingsContext = await trace('requester.settings', () => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
      credentials: input.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
      caller: 'requester_action_admission',
      allowCacheFallback: false,
      ...(input.signal ? { signal: input.signal } : {}),
      expectedAccountEncryptionMode: currentness.mode, honorAccountSettingsModeEnv: false,
      minSettingsVersion: currentness.settingsVersion, shouldCommit: () => live && !input.signal?.aborted,
    })));
    if (accountSettingsContext.source !== 'network') return refused('settings_source');
    if (!await isCurrent()) return refused('custody');
    const { requesterAccountContext: _sealed, managedFiniteWake, ...root } = parsed.data;
    const wakeFacts = managedFiniteWake ? (() => {
      const { requesterAccountContext: _controllerSealed, ...facts } = managedFiniteWake;
      return facts;
    })() : undefined;
    // A Workflow Ask reopens this original receiver box after persistence;
    // its signed origin cannot borrow the deciding Account's credential custody.
    const wire = { ...root, ...(wakeFacts ? { managedFiniteWake: wakeFacts } : {}),
      ...(root.binding.workflowActionOrigin && parsed.data.requesterAccountContext
        ? { requesterAccountContext: parsed.data.requesterAccountContext } : {}) };
    phase = 'requester_account_projection';
    const authorization = await trace('requester.account_projection', () => projectAdmittedAccountCustody({ authorization: wire,
      ...(input.invocation ? { invocation: input.invocation } : {}),
      serverIdentityId: input.serverIdentityId, bootstrap: {
      credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent: isProjectionCurrent,
      attribution: { serverId: input.serverId, accountId: profile.id, machineId: wire.binding.machineId,
        installationId: wire.binding.installationId },
    }, ...(input.signal ? { signal: input.signal } : {}) }, () => live, sourcePreparation ? isCurrent : undefined, currentness));
    if (!authorization) return refused('null_projection');
    if (!await isCurrent()) return refused('custody');
    // All asynchronous passive preparation is complete. Refuse and retire its
    // observation before constructing subscriptions or publishing private ports.
    if (sourcePreparation && !await authorization.requesterAccountProjection!.isCurrent()) return refused('currentness');
    phase = 'requester_saved_secret_context';
    const binding = parsed.data.binding;
    const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials: input.credentials,
      // The Home-signed Machine grant; native-source acquisition owns its Manage rule.
      machineAdmission: { actorAccountId: binding.accountId, custodianAccountId: binding.custodianAccountId,
        role: binding.admittedMachineRole },
      snapshot: accountSettingsContext, serverHttpBaseUrl: input.serverHttpBaseUrl,
      isCurrent: authorization.requesterAccountProjection!.isCurrent });
    savedSecrets = savedSecretOperationContext;
    settingsPublication = createRequesterAccountSettingsPublication({ observation, currentness, operationContext: savedSecretOperationContext });
    const context = createAdmittedRequesterAccountActionContext({ input, authorization, currentness,
      accountSettingsContext, savedSecretOperationContext, settingsPublication, observation,
      onRetire: async () => { live = false;
        try { settingsPublication?.dispose(); await savedSecrets?.isCurrent(); await observation?.dispose(); }
        finally { await input.onRetire?.(); } },
    });
    admitted = true;
    return context;
  } catch (error) {
    refuseAdmission(phase, 'exception', error);
    rethrowRequesterHomeReadFailure(error);
    if (phase === 'requester_profile' && !isAuthenticationError(error)) throw createActionExecuteFailureError({ ok: false,
      errorCode: 'internal_error', error: 'Requester Account profile could not be read.',
      failureCause: projectActionFailureCauseV1(error, 'requester.profile') });
    return null;
  }
  finally { if (!admitted) { live = false; settingsPublication?.dispose(); await observation?.dispose(); } }
}

/** Original Account custody excludes delegated Session/Workflow requests. */
export function isOriginalAccountActionCustody(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    && !binding.sessionActionOrigin && !binding.workflowActionOrigin;
}

/** Original own custody additionally requires the Machine's Account. */
export function isOriginalOwnAccountActionCustody(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
  return isOriginalAccountActionCustody(binding) && binding.accountId === binding.custodianAccountId;
}

/** An original input may reuse only the custody already admitted for its exact Session. */
export function isOriginalSessionInputExternalActionCustody(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
  return !binding.sessionActionOrigin && !binding.sessionActionSource && !binding.workflowActionOrigin
    && !binding.managedContinuation && !binding.handoffContinuation && !binding.handoffPreflight
    && binding.actionId === 'session.message.send' && binding.target.kind === 'session';
}

/** Private requester material additionally requires Account/terminal authentication. */
export function isOriginalSessionInputAccountActionCustody(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    && isOriginalSessionInputExternalActionCustody(binding);
}

/** Original Session custody is available only at its signed source installation. */
export function readOriginalRequesterSessionCustodyId(binding: ExternalActionExecutionAuthorizationBindingV1): string | null {
  if (isOriginalSessionInputAccountActionCustody(binding) && binding.target.kind === 'session') return binding.target.sessionId;
  const origin = binding.sessionActionOrigin;
  const source = binding.sessionActionSource;
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    && !binding.workflowActionOrigin && origin?.caller.kind === 'session'
    && source?.machineId === binding.machineId && source.installationId === binding.installationId
    ? origin.caller.sessionId : null;
}

type RequesterSessionInputCustody = Pick<AdmittedRequesterSessionBootstrap,
  'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'> & Readonly<{
    release(): Promise<void>;
  }>;

/** One installed ingress for both existing Action and Machine-RPC authorization carriers. */
export async function prepareInstalledRequesterAccountActionContext(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  machineId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  ownCredentials?: StoredCredentials;
  /** Local host custody beyond finite ingress; never a signed root recheck. */
  isRetainedCustodyCurrent?: () => Promise<boolean>;
  /** Existing installed Session owner; never resolves custody by Account alone. */
  resolveRequesterSessionBootstrap?: (sessionId: string, attribution: AdmittedRequesterSessionBootstrap['attribution']) => Promise<RequesterSessionInputCustody | null>;
  /** Manager-owned recheck of the exact Home-verified signed SOURCE request, private to preparation. */
  verifyWorkspaceSyncPrepareCurrent?: () => Promise<boolean>;
  /** Manager-owned admission of the exact forwarded finite child. */
  verifyServiceMoveChildCurrent?: () => Promise<boolean>;
  deploymentChildExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
  resolveCurrentMachineExecutionOriginContext(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
  createExecutor(context: RequesterAccountActionContext, installation: NonNullable<ReturnType<typeof readInstallationIdentityIfExistsSync>>):
    NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountExecutor']>;
  signal?: AbortSignal;
}>): ReturnType<PrepareExternalActionRequesterAccountContext> {
  const installation = readInstallationIdentityIfExistsSync();
  const trace = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(
    input.authorization.binding.actionId, input.authorization.binding.requestId, stage, operation);
  const origin = await trace('requester.initial_origin', () => input.resolveCurrentMachineExecutionOriginContext(input.signal));
  if (!installation || !origin || origin.machineId !== input.machineId) {
    const phase = !installation ? 'requester_installation_missing'
      : !origin ? 'requester_origin_unavailable' : 'requester_origin_machine_mismatch';
    refuseExternalActionPhase(phase, input.machineId, undefined, {
      ...readSessionInputAdmissionDiagnostic(input.authorization.binding), refusalBranch: phase,
    });
    return null;
  }
  const binding = input.authorization.binding;
  const custodySessionId = readOriginalRequesterSessionCustodyId(binding);
  const reusesSessionCustody = input.purpose.kind === 'external_action'
    && !input.authorization.requesterAccountContext && custodySessionId !== null;
  if (reusesSessionCustody && (binding.serverIdentityId !== origin.serverIdentityId
    || binding.machineId !== input.machineId || binding.installationId !== installation.installationId)) {
    refuseExternalActionPhase('requester_session_custody', input.machineId, undefined, {
      ...readSessionInputAdmissionDiagnostic(binding),
      refusalBranch: 'session_custody',
    });
    return null;
  }
  const installationPrivateKey = decodeBase64(installation.privateKey, 'base64url');
  const requesterSessionBootstrap = reusesSessionCustody && custodySessionId !== null
    ? await input.resolveRequesterSessionBootstrap?.(custodySessionId, { serverId: input.serverId,
      accountId: binding.accountId, machineId: input.machineId, installationId: installation.installationId }) ?? null : null;
  const isCustodyCurrent = async () => {
    const refused = (refusalBranch: string) => {
      recordRequesterCurrentnessRefusal(refusalBranch === 'cancelled' ? 'local_abort_signal' : 'installation_custody');
      if (binding.actionId === 'session.message.send') refuseExternalActionPhase('requester_installed_custody', input.machineId, undefined, {
        ...readSessionInputAdmissionDiagnostic(binding), refusalBranch,
      }); return false;
    };
    if (input.signal?.aborted) return refused('cancelled');
    if (requesterSessionBootstrap) {
      if (!await requesterSessionBootstrap.isCurrent()) return refused('session_currentness');
    }
    if (input.signal?.aborted) return refused('cancelled');
    return true;
  };
  return await prepareRequesterAccountActionContext({ ...input, installationId: installation.installationId,
    ...(requesterSessionBootstrap ? { requesterSessionBootstrap } : {}),
    serverIdentityId: origin.serverIdentityId, installationPrivateKey,
    // SOURCE admission brackets passive preparation with its manager-owned
    // fresh proof; its retained ports keep that full proof, not installed custody.
    // The installed Stop receiver has the same split as external Actions:
    // HTTP destinations admit signed effects; native Stop consumes the local
    // custody of the already-admitted invocation.
    // Do not repeat Home root admission while opening its private read ports.
    // An admitted finite wake likewise runs on local custody and cancellation.
    ...(input.purpose.kind === 'external_action'
      || input.purpose.kind === 'managed_finite_wake'
      || input.purpose.kind === 'workspace_sync_prepare'
      || input.purpose.kind === 'machine_rpc' && input.purpose.method === RPC_METHODS.STOP_SESSION
        && binding.actionId === 'session.stop'
      || input.purpose.kind === 'machine_rpc' && (input.purpose.recipient || input.verifyServiceMoveChildCurrent) ? { isCustodyCurrent } : {}),
    isCurrent: async () => {
      if (!await isCustodyCurrent()) return false;
      const current = await trace('requester.fresh_origin', () => input.resolveCurrentMachineExecutionOriginContext(input.signal));
      if (current?.machineId !== input.machineId || current.serverIdentityId !== origin.serverIdentityId) return false;
      if (input.purpose.kind === 'workspace_sync_prepare') {
        return input.verifyWorkspaceSyncPrepareCurrent !== undefined && await input.verifyWorkspaceSyncPrepareCurrent();
      }
      if (input.purpose.kind === 'machine_rpc' && (input.purpose.recipient || input.verifyServiceMoveChildCurrent)) {
        return input.verifyServiceMoveChildCurrent !== undefined && await input.verifyServiceMoveChildCurrent();
      }
      return await trace('requester.root_verification', () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: input.authorization,
        effectActionId: input.authorization.binding.actionId, target: input.authorization.binding.target,
        installationId: installation.installationId, privateKey: installation.privateKey,
        serverHttpBaseUrl: input.serverHttpBaseUrl,
        ...(input.purpose.kind === 'managed_finite_wake' ? { managedFiniteWakeTarget: input.purpose.target } : {}),
        ...(input.signal ? { signal: input.signal } : {}) }));
    }, createExecutor: admitted => input.createExecutor(admitted, installation) });
}

export async function prepareRequesterAccountActionContext(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  deploymentChildExecution?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceExecutionV1;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  machineId: string;
  installationId: string;
  installationPrivateKey: Uint8Array;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  /** Host-owned custody only; never admitted from a public request or selected by Account id. */
  ownCredentials?: StoredCredentials;
  requesterSessionBootstrap?: RequesterSessionInputCustody;
  isCurrent(): Promise<boolean>;
  isCustodyCurrent?: () => Promise<boolean>;
  isRetainedCustodyCurrent?: () => Promise<boolean>;
  createExecutor(context: RequesterAccountActionContext): NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountExecutor']>;
  signal?: AbortSignal;
}>): ReturnType<PrepareExternalActionRequesterAccountContext> {
  const sessionCustody = input.requesterSessionBootstrap;
  let custodyTransferred = false;
  try {
    const root = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
    const refused = (phase: string, error?: unknown) => { refuseExternalActionPhase(phase, input.machineId, error, root.success ? {
      ...readSessionInputAdmissionDiagnostic(root.data.binding), refusalBranch: phase,
    } : undefined); return null; };
    // Reject a different root/Session before consulting retained private custody.
    // admitRequesterAccountActionContext owns the fresh Home admission below.
    if (!root.success || root.data.binding.serverIdentityId !== input.serverIdentityId) return refused('requester_preparation_root');
    const trace = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(
      root.data.binding.actionId, root.data.binding.requestId, stage, operation);
    const finiteWake = input.purpose.kind === 'managed_finite_wake' ? root.data.managedFiniteWake : undefined;
    const preparation = input.purpose.kind === 'workspace_sync_prepare' ? input.purpose : undefined;
    const moveRecipient = input.purpose.kind === 'machine_rpc' ? input.purpose.recipient : undefined;
    const stopChildTarget = isSessionStopChildRootV1(root.data.binding.actionId) && input.purpose.kind === 'machine_rpc'
      && input.purpose.method === RPC_METHODS.STOP_SESSION ? readSessionStopChildTargetV1(input.purpose.params) : null;
    const deploymentChild = input.purpose.kind === 'machine_rpc' ? readDeploymentChildRpcV1({ deploymentChildRoot: input.authorization.binding.deploymentChildRoot,
      rootActionId: root.data.binding.actionId, rootPreparationAdmission: root.data.binding.deploymentPreparationAdmission,
      effectActionId: input.deploymentChildExecution?.externalActionExecution.effectActionId
        ?? deploymentChildEffectActionIdForRootV1(root.data.binding.actionId, root.data.binding.deploymentPreparationAdmission) ?? '',
      reviewedChild: input.deploymentChildExecution?.externalActionExecution.reviewedChild,
      method: input.purpose.method, params: input.purpose.params }) : null;
    const setupPlan = input.purpose.kind === 'machine_rpc' && isMachineSetupPlanRpcChildV1({ rootActionId: root.data.binding.actionId,
      effectActionId: 'machines.setup.plan', method: input.purpose.method })
      ? MachineSetupPlanInputV1Schema.safeParse(input.purpose.params) : null;
    const setupPlanChild = setupPlan?.success && setupPlan.data.homeId === input.serverIdentityId
      && setupPlan.data.machineId === moveRecipient?.machineId;
    if (moveRecipient && !(root.data.binding.actionId === 'projects.service.relocate'
      || input.purpose.kind === 'machine_rpc' && readSessionActionChildCreationRpcEffectV1(
        input.purpose.method, root.data.binding, moveRecipient, input.purpose.reviewedChild) !== null
      || stopChildTarget !== null || deploymentChild !== null || setupPlanChild)) return refused('requester_move_root');
    if (preparation && (!isProjectWorkspaceSyncPreparationActionV1(root.data.binding.actionId)
      || root.data.binding.target.kind !== 'machine' || root.data.binding.target.machineId !== root.data.binding.machineId)) return refused('requester_workspace_preparation_root');
    if (input.purpose.kind === 'managed_finite_wake' && (!finiteWake
      || !sameStrictJsonValue(finiteWake.target, input.purpose.target))) return refused('requester_finite_wake_target');
    const recipient = moveRecipient ?? preparation?.controller ?? finiteWake?.target.controller ?? { machineId: root.data.binding.machineId,
      installationId: root.data.binding.installationId };
    if (recipient.machineId !== input.machineId || recipient.installationId !== input.installationId) return refused('requester_preparation_recipient');
    const regularOwnAccount = isOriginalOwnAccountActionCustody(root.data.binding);
    const custodySessionId = readOriginalRequesterSessionCustodyId(root.data.binding);
    if (sessionCustody && (custodySessionId === null
      || input.purpose.kind !== 'external_action'
      || sessionCustody.getBoundSessionId() !== custodySessionId
      || sessionCustody.attribution.accountId !== root.data.binding.accountId
      || sessionCustody.attribution.serverId !== input.serverId
      || sessionCustody.attribution.machineId !== input.machineId
      || sessionCustody.attribution.installationId !== input.installationId
      || normalizeServerHttpBaseUrl(sessionCustody.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(input.serverHttpBaseUrl))) return refused('requester_session_custody');
    if (input.signal?.aborted) return refused('requester_preparation_cancelled');
    if (!await (input.isCustodyCurrent ?? input.isCurrent)()) return refused(input.isCustodyCurrent
      ? 'requester_preparation_custody' : 'requester_preparation_currentness');
    if (sessionCustody && !await sessionCustody.isCurrent()) return refused('requester_session_currentness');
    const hasBox = finiteWake ? Boolean(finiteWake.requesterAccountContext) : Boolean(root.data.requesterAccountContext);
    const encoded = hasBox ? openExternalActionRequesterAccountContextV1({ ...input, includeInvocation: true }) : null;
    const retainedCredentials = sessionCustody?.credentials ?? (regularOwnAccount ? input.ownCredentials : undefined);
    const credentials = hasBox
      ? encoded ? decodeStoredCredentials(encoded.credentials) : null
      : !moveRecipient && !preparation && !finiteWake && retainedCredentials
        // Admission binds invocation scope in place. Borrow a private copy so
        // installed custody stays current, preserving any existing private scope.
        ? Object.defineProperties({ ...retainedCredentials }, Object.getOwnPropertyDescriptors(retainedCredentials))
        : null;
    if (!credentials) return refused('requester_credentials_open');
    const admitted = await admitRequesterAccountActionContext({ ...input, credentials,
      ...(deploymentChild ? { deploymentChild } : {}),
      ...(sessionCustody ? { onRetire: () => sessionCustody.release() } : {}),
      ...(encoded?.invocation ? { invocation: encoded.invocation } : {}) });
    if (!admitted) return refused('requester_account_admission');
    custodyTransferred = true;
    let phase = 'requester_http_projection';
    try {
      const prepareAuthorization = async (context: RequesterAccountActionContext, signal?: AbortSignal, rootAdmitted = false) => {
        const bound = rebindRequesterAccountActionContext(context.authorization, context.authorization, context);
        // Native preparation proves controller custody, not a generic HTTP grant.
        // Retaining that custody must preserve the same restriction.
        const projected = finiteWake || preparation ? bound : await trace('requester.http_projection', () => projectExternalActionRequesterHttpAuthorization({ authorization: bound,
          serverId: input.serverId, serverIdentityId: input.serverIdentityId, serverHttpBaseUrl: input.serverHttpBaseUrl,
          target: stopChildTarget ?? bound.binding.target, installationId: input.installationId,
          privateKey: input.installationPrivateKey, isCurrent: context.isCustodyCurrent ?? context.isCurrent,
          ...(rootAdmitted ? { rootAdmitted: true } : {}),
          ...(moveRecipient ? { forwardedMove: { credentials: context.credentials, isCurrent: context.isCurrent,
            ...(input.purpose.kind === 'machine_rpc' ? { method: input.purpose.method,
              reviewedChild: input.purpose.reviewedChild } : {}) } } : {}),
          ...(deploymentChild ? { forwardedDeploymentChild: deploymentChild } : {}),
          ...(deploymentChild && input.deploymentChildExecution ? { deploymentChildExecution: input.deploymentChildExecution } : {}),
          ...(signal ? { signal } : {}) }));
        if (!projected) return null;
        phase = 'requester_executor';
        const executor = input.createExecutor(Object.freeze({ ...context, authorization: projected }));
        const authorization: ExternalActionExecutionAuthorizationV1 = { ...projected };
        for (const [key, value] of Object.entries({ requesterAccountProjection: projected.requesterAccountProjection,
          requesterHttpProjection: projected.requesterHttpProjection, requesterAccountExecutor: executor })) {
          if (value) Object.defineProperty(authorization, key, { value, enumerable: false });
        }
        return { authorization: rebindRequesterAccountActionContext(authorization, projected, context), executor };
      };
      const retainOperation = async (source: RequesterAccountActionContext, signal: AbortSignal):
        ReturnType<NonNullable<RequesterAccountActionContext['retainForOperation']>> => {
        const custody = source.retainCustody!(signal);
        try {
          if (!await custody.prepareForOperation()) {
            signal.throwIfAborted();
            throw createRequesterAccountContextRetiredError(false);
          }
          // Reuse the admitted encryption witness and retained installed lifetime;
          // neither the original transport nor a second Home admission owns this work.
          const authorization = await projectAdmittedAccountCustody({ authorization: source.authorization,
            ...(source.invocation ? { invocation: source.invocation } : {}),
            serverIdentityId: input.serverIdentityId, signal, bootstrap: {
              credentials: source.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent: custody.isCurrent,
              attribution: { serverId: input.serverId, accountId: root.data.binding.accountId,
                machineId: root.data.binding.machineId, installationId: root.data.binding.installationId },
            } }, undefined, custody.isCurrent, source.accountEncryptionCurrentness);
          if (!authorization) throw createRequesterAccountContextRetiredError(false);
          const isCurrent = authorization.requesterAccountProjection!.isCurrent;
          const context: RequesterAccountActionContext = Object.freeze({ ...source, authorization, isCurrent,
            ...(source.isCustodyCurrent ? { isCustodyCurrent: isCurrent } : {}),
            savedSecretOperationContext: custody.savedSecretOperationContext,
            refreshAccountSettings: custody.refreshAccountSettings,
            resolveEncryption: createRequesterEncryptionResolver(source.credentials, input.serverIdentityId, isCurrent),
            retainCustody: custody.retainCustody,
            retainForOperation: signal => retainOperation(context, signal), dispose: custody.release });
          const prepared = await prepareAuthorization(context, signal, true);
          if (!prepared) throw createRequesterAccountContextRetiredError(false);
          return { authorization: prepared.authorization, dispose: custody.release };
        } catch (error) { await custody.release(); throw error; }
      };
      const retainForOperation: RequesterAccountActionContext['retainForOperation'] = admitted.retainCustody
        ? signal => retainOperation(admitted, signal) : undefined;
      const prepared = await prepareAuthorization(Object.freeze({ ...admitted,
        ...(retainForOperation ? { retainForOperation } : {}) }), input.signal);
      if (!prepared) { await admitted.dispose(); return refused(phase); }
      return { ...prepared, dispose: admitted.dispose, resolveEncryption: admitted.resolveEncryption,
        actionsSettings: admitted.accountSettingsContext.settings.actionsSettingsV1,
        ...(encoded?.invocation ? { invocation: encoded.invocation } : {}) };
    } catch (error) { await admitted.dispose(); rethrowRequesterHomeReadFailure(error); return refused(phase, error); }
  } finally { if (!custodyTransferred) await sessionCustody?.release(); }
}

export type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
export { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
