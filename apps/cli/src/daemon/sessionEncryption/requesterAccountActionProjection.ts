import type { RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { deploymentPreparationOperationForActionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1,
  type ExternalActionExecutionAuthorizationBindingV1,
  type ExternalActionRequesterAccountProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { acquireRequesterAccountEncryptionCurrentness, readRequesterAccountEncryptionCurrentness, sameRequesterAccountEncryptionCurrentness, isRequesterAccountEncryptionCurrentnessObserved } from '@/api/client/accountEncryptionCurrentnessObservation';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";
import { type AdmittedRequesterSessionBootstrap } from "./requesterSessionCredentials";
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { fetchAccountProfile } from '@/api/accountProfile';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { bootstrapAccountSettingsContext } from "@/settings/accountSettings/bootstrapAccountSettingsContext";
import { resolvePublishedMachineEncryptionContext } from '@/api/machine/machineDataEncryptionKey';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1,
  type ExternalActionRequesterAccountContextPurposeV1,
  type ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { PrepareExternalActionRequesterAccountContext, ResolveExternalActionEncryption } from '../externalActions/executeExternalAction';
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
    || parsed.data.binding.serverIdentityId !== input.serverIdentityId) return null;
  return await projectAdmittedAccountCustody(input);
}

/** Both admitted owners use these same Account ports; Session provenance stays in its caller guard. */
async function projectAdmittedAccountCustody(
  input: RequesterAccountActionAuthorizationInput,
  isCustodyLive: () => boolean = () => true,
  isPreparationCurrent = () => input.bootstrap.isCurrent(),
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
    const currentness = await readRequesterAccountEncryptionCurrentness({ accountId: stamp.accountId, token: bootstrap.credentials.token,
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
      const diagnose = (phase: string) => { if (parsed.data.binding.actionId === 'session.message.send') refused(phase); };
      try {
        if (input.signal?.aborted) { diagnose('requester_projection_cancelled'); return false; }
        if (!isCustodyLive()) { diagnose('requester_projection_custody'); return false; }
        if (!isRequesterAccountEncryptionCurrentnessObserved({ accountId: stamp.accountId,
          token: bootstrap.credentials.token, serverBaseUrl: bootstrap.serverHttpBaseUrl }, currentness)) {
          diagnose('requester_projection_observation'); return false;
        }
        const next = await readRequesterAccountEncryptionCurrentness({ accountId: stamp.accountId, token: bootstrap.credentials.token,
          serverBaseUrl: bootstrap.serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) });
        // Account seq also advances for unrelated activity; encryption custody follows its own mode/key transition.
        if (!sameRequesterAccountEncryptionCurrentness(next, currentness)) { diagnose('requester_projection_encryption_currentness'); return false; }
        // Preserve the existing short-circuit order and one bootstrap read.
        if (input.signal?.aborted) { diagnose('requester_projection_cancelled'); return false; }
        if (!await bootstrap.isCurrent()) { diagnose('requester_projection_custody'); return false; }
        if (input.signal?.aborted) { diagnose('requester_projection_cancelled'); return false; }
        if (!isCustodyLive()) { diagnose('requester_projection_custody'); return false; }
        const observed = isRequesterAccountEncryptionCurrentnessObserved({ accountId: stamp.accountId,
          token: bootstrap.credentials.token, serverBaseUrl: bootstrap.serverHttpBaseUrl }, currentness);
        if (!observed) diagnose('requester_projection_observation');
        return observed;
      } catch (error) { refuseExternalActionPhase('requester_projection_currentness', stamp.machineId, error, {
        ...readSessionInputAdmissionDiagnostic(parsed.data.binding), refusalBranch: 'exception',
      }); rethrowRequesterHomeReadFailure(error); return false; }
    };
    // Loaded only when a real admitted invocation asks for private Account ports.
    phase = 'requester_projection_ports';
    const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
    const artifacts = createCredentialedAccountArtifactStore(bootstrap.credentials);
    const { createProjectSetupTrustRowCipher } = await import('@/workspaces/projectSetup/projectSetupTrust');
    const { createAuthoringMemoryRowCipher } = await import('@/settings/authoringMemory/createAuthoringMemoryClient');
    const { projectAccountArtifactToPromptLibraryStoredArtifact } = await import('@/session/actions/approvals/artifactStore');
    const projection: ExternalActionRequesterAccountProjectionV1 = Object.freeze({
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
            credentials: { ...encodeStoredCredentials(bootstrap.credentials), token: bootstrap.credentials.token },
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
          const workspace = await readOwnSessionMachineWorkspace({ ...request, credentials: bootstrap.credentials,
            serverHttpBaseUrl: bootstrap.serverHttpBaseUrl });
          return request.signal?.aborted || !await isCurrent() ? null : workspace;
        } catch (error) { refuseExternalActionPhase('requester_workspace_read', stamp.machineId, error); return null; }
      },
      readArtifact: async (ref, options) => {
        if (!await isServerProfileHomeIdentity(stamp.serverId, ref.serverId) || options?.signal?.aborted || !await isCurrent()) return null;
        try {
          const root = parsed.data.binding;
          const publish = root.actionId === 'deployments.publish';
          const appUpdate = root.actionId === 'registries.updates.check' && root.registryAppUpdateAdmission !== undefined;
          const preparation = root.deploymentPreparationAdmission;
          const setup = deploymentPreparationOperationForActionV1(root.actionId) === 'setup' && preparation?.operation === 'setup';
          const signedDocument = publish || appUpdate || setup;
          const candidate = publish && preparation?.operation === 'publish' ? preparation.candidate : undefined;
          const supplied = ExternalActionExecutionAuthorizationV1Schema.safeParse(options?.authorization);
          const http = options?.authorization?.requesterHttpProjection;
          if (publish && (!candidate || candidate.contentArtifactId !== ref.artifactId)) return null;
          if (signedDocument && (!supplied.success || supplied.data.token !== parsed.data.token || !sameStrictJsonValue(supplied.data.binding, root)
            || !http || http.accountId !== stamp.accountId || http.serverId !== stamp.serverId
            || http.serverIdentityId !== input.serverIdentityId
            || normalizeServerHttpBaseUrl(http.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(bootstrap.serverHttpBaseUrl)
            || !await http.isCurrent())) return null;
          const authorizationHeaders: import('@/api/artifacts/accountArtifactStore').ArtifactRequestAuthorizationHeaders | undefined = signedDocument
            ? async request => {
              const headers = http && await http.createRequestHeaders({ ...request, effectActionId: root.actionId,
                ...(options?.signal ? { signal: options.signal } : {}) });
              if (!headers || headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== parsed.data.token)
                throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
              return { ...headers };
            } : undefined;
          const artifact = await runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl,
            () => artifacts.read(ref.artifactId, { ...(options?.signal ? { signal: options.signal } : {}), includeSharedAudience: false,
              ...(authorizationHeaders ? { authorizationHeaders, prepareRecipients: false } : {}) }));
          if (!artifact || artifact.artifactId !== ref.artifactId
            || options?.signal?.aborted || !await isCurrent() || signedDocument && !await http!.isCurrent()) return null;
          if (candidate && (artifact.revision.headerVersion !== candidate.contentHeaderVersion
            || artifact.revision.bodyVersion !== candidate.contentBodyVersion)) return null;
          const promptLibraryArtifact = projectAccountArtifactToPromptLibraryStoredArtifact(artifact);
          return { artifactId: artifact.artifactId, header: artifact.header,
            ...(signedDocument ? { document: { artifactId: artifact.artifactId, header: artifact.header,
              body: artifact.body, revision: artifact.revision } } : {}),
            ...(promptLibraryArtifact ? { promptLibraryArtifact } : {}) };
        } catch (error) { refuseExternalActionPhase('requester_artifact_read', stamp.machineId, error); return null; }
      },
    });
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

export async function resolveAdmittedRequesterAccountReadRuntime(input: Readonly<{
  ingress: RpcHandlerContext; serverId: string; machineId: string; installationId: string;
  isInstalledCurrent(): boolean | Promise<boolean>;
}>): Promise<AdmittedRequesterAccountReadRuntime | null> {
  const { ingress } = input;
  const admission = ingress.machineAdmission;
  const authorization = ingress.callerInputAuthorization;
  const account = authorization?.requesterAccountProjection;
  const http = authorization?.requesterHttpProjection;
  const packet = ingress.workspaceSyncSourceExecution;
  const forwardedMove = (authorization?.binding.actionId === 'projects.service.relocate'
    || authorization?.binding.actionId === 'discussion.second_opinion.start'
      && packet?.externalActionExecution.effectActionId === 'session.spawn_new'
      && (packet.method === `${input.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`
        || packet.method === `${input.machineId}:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`)) && packet?.originalActionEnvelope
    && ingress.originalActionEnvelope && sameStrictJsonValue(packet.originalActionEnvelope, ingress.originalActionEnvelope)
    && packet.externalActionExecution.authorization.token === authorization.token
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
  return await isCurrent() ? { serverId: input.serverId, machineId: input.machineId, accountId: account.accountId,
    accountAuthorization: authorization, serverHttpBaseUrl: http.serverHttpBaseUrl, isCurrent } : null;
}

export async function admitRequesterAccountActionContext(input: Readonly<{
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
  /** Transferred only after successful admission; runs at final retained retirement. */
  onRetire?: () => Promise<void>;
  signal?: AbortSignal;
}>): Promise<RequesterAccountActionContext | null> {
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
  let references = 1;
  let ingressReleased = false;
  let settingsPublication: ReturnType<typeof createRequesterAccountSettingsPublication> | undefined;
  let savedSecrets: SavedSecretOperationContextV1 | undefined;
  const release = async () => { if (--references === 0) { live = false;
    try { settingsPublication?.dispose(); await savedSecrets?.isCurrent(); await observation?.dispose(); }
    finally { await input.onRetire?.(); } } };
  const retain = () => {
    if (!live) throw new Error('requester_account_context_retired');
    references += 1;
    let released = false;
    return async () => { if (!released) { released = true; await release(); } };
  };
  const isCurrent = async () => live && !input.signal?.aborted
    && await (input.isCustodyCurrent ?? input.isCurrent)() && live && !input.signal?.aborted;
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
    // Root admission above already binds these passive HTTP reads to this
    // credential. Join both before opening Settings; profile refusal retains
    // precedence, and the floor must still match the live encryption identity.
    const [profileRead, settingsFloorRead] = await Promise.allSettled([
      trace('requester.profile', () => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () =>
        fetchAccountProfile({ token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }))),
      trace('requester.settings_currentness', () => fetchAccountEncryptionCurrentness({
        credentials: input.credentials, token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl,
        allowCredentialRecovery: false,
        ...(input.signal ? { signal: input.signal } : {}),
      })),
    ]);
    if (profileRead.status === 'rejected') throw profileRead.reason;
    const profile = profileRead.value;
    if (profile.id !== parsed.data.binding.accountId) return refused('profile_identity');
    if (input.signal?.aborted) return refused('cancelled');
    phase = 'requester_encryption_currentness';
    observation = acquireRequesterAccountEncryptionCurrentness({ accountId: profile.id,
      token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl });
    const currentness = await trace('requester.encryption_currentness', () => observation!.read(input.signal));
    phase = 'requester_account_mode';
    if (parsed.data.binding.accountEncryptionMode !== currentness.mode) return refused('mode', currentness.mode);
    if (currentness.mode === 'plain' ? input.credentials.encryption !== null : input.credentials.encryption === null) return refused('mode_material', currentness.mode);
    if (!await isCurrent()) return refused('custody', currentness.mode);
    phase = 'requester_content_key';
    if (currentness.mode === 'e2ee' && currentness.contentKeyFingerprint && input.credentials.encryption) {
      const encryption = input.credentials.encryption;
      const key = encryption.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret) : encryption.machineKey;
      if (computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey) !== currentness.contentKeyFingerprint) return refused();
    }
    bindRequesterSessionCredentialScope(input.credentials, { serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl });
    phase = 'requester_settings';
    // Finite admission needs a current Settings floor even when its live
    // encryption identity has remained unchanged since another holder joined.
    if (settingsFloorRead.status === 'rejected') throw settingsFloorRead.reason;
    const settingsWitness = settingsFloorRead.value;
    if (!sameRequesterAccountEncryptionCurrentness(settingsWitness, currentness)
      || !observation.isCurrent(currentness)) return refused('settings_identity');
    const accountSettingsContext = await trace('requester.settings', () => runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
      credentials: input.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
      caller: 'requester_action_admission',
      allowCacheFallback: false,
      ...(input.signal ? { signal: input.signal } : {}),
      expectedAccountEncryptionMode: currentness.mode, honorAccountSettingsModeEnv: false,
      minSettingsVersion: settingsWitness.settingsVersion, shouldCommit: () => live && !input.signal?.aborted,
    })));
    if (accountSettingsContext.source !== 'network') return refused('settings_source');
    if (!await isCurrent()) return refused('custody');
    const { requesterAccountContext: _sealed, managedFiniteWake, ...root } = parsed.data;
    const wakeFacts = managedFiniteWake ? (() => {
      const { requesterAccountContext: _controllerSealed, ...facts } = managedFiniteWake;
      return facts;
    })() : undefined;
    const wire = { ...root, ...(wakeFacts ? { managedFiniteWake: wakeFacts } : {}) };
    phase = 'requester_account_projection';
    const authorization = await trace('requester.account_projection', () => projectAdmittedAccountCustody({ authorization: wire,
      ...(input.invocation ? { invocation: input.invocation } : {}),
      serverIdentityId: input.serverIdentityId, bootstrap: {
      credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent: isProjectionCurrent,
      attribution: { serverId: input.serverId, accountId: profile.id, machineId: wire.binding.machineId,
        installationId: wire.binding.installationId },
    }, ...(input.signal ? { signal: input.signal } : {}) }, () => live, sourcePreparation ? isCurrent : undefined));
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
    const refreshAccountSettings = settingsPublication.ensureCurrent;
    const resolveEncryption: ResolveExternalActionEncryption = async signal => {
      if (signal?.aborted || !await authorization.requesterAccountProjection!.isCurrent() || !input.credentials.encryption) return null;
      const encryption = input.credentials.encryption;
      return { serverIdentityId: input.serverIdentityId, material: encryption.type === 'legacy'
        ? { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(encryption.secret) }
        : encryption };
    };
    // HTTP projection retains this exact private Account facet. Its symbol is
    // not an authorization input and never enters the public carrier schema.
    const projection = { ...authorization.requesterAccountProjection! };
    const carrier: ExternalActionExecutionAuthorizationV1 = Object.defineProperties({ ...authorization }, {
      ...Object.getOwnPropertyDescriptors(authorization),
      requesterAccountProjection: { value: projection, enumerable: false },
    });
    const context: RequesterAccountActionContext = Object.freeze({ credentials: input.credentials, accountSettingsContext, savedSecretOperationContext,
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
      retain,
      dispose: async () => { if (!ingressReleased) { ingressReleased = true; await release(); } },
    });
    Object.defineProperty(projection, requesterActionContext, { value: context, enumerable: false });
    Object.freeze(projection);
    Object.freeze(carrier);
    admitted = true;
    return context;
  } catch (error) {
    refuseAdmission(phase, 'exception', error);
    rethrowRequesterHomeReadFailure(error);
    return null;
  }
  finally { if (!admitted) { live = false; settingsPublication?.dispose(); await observation?.dispose(); } }
}

/** Original own custody excludes delegated Session/Workflow requests and foreign Accounts. */
export function isOriginalOwnAccountActionCustody(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    && !binding.sessionActionOrigin && !binding.workflowActionOrigin
    && binding.accountId === binding.custodianAccountId;
}

/** An original input may reuse only the custody already admitted for its exact Session. */
export function isOriginalSessionInputAccountActionCustody(binding: ExternalActionExecutionAuthorizationBindingV1): boolean {
  return 'authentication' in binding
    && (binding.authentication.kind === 'account' || binding.authentication.kind === 'terminal')
    && !binding.sessionActionOrigin && !binding.sessionActionSource && !binding.workflowActionOrigin
    && !binding.managedContinuation && !binding.handoffContinuation && !binding.handoffPreflight
    && binding.actionId === 'session.message.send' && binding.target.kind === 'session';
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
  /** Existing installed Session owner; never resolves custody by Account alone. */
  resolveRequesterSessionBootstrap?: (sessionId: string, attribution: AdmittedRequesterSessionBootstrap['attribution']) => Promise<RequesterSessionInputCustody | null>;
  /** Manager-owned recheck of the exact Home-verified signed SOURCE request, private to preparation. */
  verifyWorkspaceSyncPrepareCurrent?: () => Promise<boolean>;
  /** Manager-owned proof of the exact forwarded Move child, including current destination access. */
  verifyServiceMoveChildCurrent?: () => Promise<boolean>;
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
  const reusesSessionCustody = input.purpose.kind === 'external_action'
    && !input.authorization.requesterAccountContext && isOriginalSessionInputAccountActionCustody(binding);
  if (reusesSessionCustody && (binding.serverIdentityId !== origin.serverIdentityId
    || binding.machineId !== input.machineId || binding.installationId !== installation.installationId)) {
    refuseExternalActionPhase('requester_session_custody', input.machineId, undefined, {
      ...readSessionInputAdmissionDiagnostic(binding),
      refusalBranch: 'session_custody',
    });
    return null;
  }
  const installationPrivateKey = decodeBase64(installation.privateKey, 'base64url');
  const requesterSessionBootstrap = reusesSessionCustody && binding.target.kind === 'session'
    ? await input.resolveRequesterSessionBootstrap?.(binding.target.sessionId, { serverId: input.serverId,
      accountId: binding.accountId, machineId: input.machineId, installationId: installation.installationId }) ?? null : null;
  const isCustodyCurrent = async () => {
    const refused = (refusalBranch: string) => {
      if (binding.actionId === 'session.message.send') refuseExternalActionPhase('requester_installed_custody', input.machineId, undefined, {
        ...readSessionInputAdmissionDiagnostic(binding), refusalBranch,
      }); return false;
    };
    const before = readInstallationIdentityIfExistsSync();
    if (input.signal?.aborted) return refused('cancelled');
    if (before?.installationId !== installation.installationId || before.privateKey !== installation.privateKey) return refused('installation');
    if (requesterSessionBootstrap && !await requesterSessionBootstrap.isCurrent()) return refused('session_currentness');
    const after = readInstallationIdentityIfExistsSync();
    if (input.signal?.aborted) return refused('cancelled');
    if (after?.installationId !== installation.installationId || after.privateKey !== installation.privateKey) return refused('installation');
    return true;
  };
  return await prepareRequesterAccountActionContext({ ...input, installationId: installation.installationId,
    ...(requesterSessionBootstrap ? { requesterSessionBootstrap } : {}),
    serverIdentityId: origin.serverIdentityId, installationPrivateKey,
    // SOURCE admission brackets passive preparation with its manager-owned
    // fresh proof; its retained ports keep that full proof, not installed custody.
    // The installed Stop receiver has the same split as external Actions:
    // HTTP destinations admit signed observations, and its native Stop port
    // calls admitted.isCurrent() immediately before the physical effect.
    // Do not repeat Home root admission while opening its private read ports.
    ...(input.purpose.kind === 'external_action'
      || input.purpose.kind === 'workspace_sync_prepare'
      || input.purpose.kind === 'machine_rpc' && input.purpose.method === RPC_METHODS.STOP_SESSION
        && binding.actionId === 'session.stop'
      || input.purpose.kind === 'machine_rpc' && input.purpose.recipient ? { isCustodyCurrent } : {}),
    isCurrent: async () => {
      if (!await isCustodyCurrent()) return false;
      const current = await trace('requester.fresh_origin', () => input.resolveCurrentMachineExecutionOriginContext(input.signal));
      if (current?.machineId !== input.machineId || current.serverIdentityId !== origin.serverIdentityId) return false;
      if (input.purpose.kind === 'workspace_sync_prepare') {
        return input.verifyWorkspaceSyncPrepareCurrent !== undefined && await input.verifyWorkspaceSyncPrepareCurrent();
      }
      if (input.purpose.kind === 'machine_rpc' && input.purpose.recipient) {
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
    if (moveRecipient && !(root.data.binding.actionId === 'projects.service.relocate'
      || root.data.binding.actionId === 'discussion.second_opinion.start'
        && input.purpose.kind === 'machine_rpc' && (input.purpose.method === RPC_METHODS.SESSION_SPAWN_NEW
          || input.purpose.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT))) return refused('requester_move_root');
    if (preparation && (!isProjectWorkspaceSyncPreparationActionV1(root.data.binding.actionId)
      || root.data.binding.target.kind !== 'machine' || root.data.binding.target.machineId !== root.data.binding.machineId)) return refused('requester_workspace_preparation_root');
    if (input.purpose.kind === 'managed_finite_wake' && (!finiteWake
      || !sameStrictJsonValue(finiteWake.target, input.purpose.target))) return refused('requester_finite_wake_target');
    const recipient = moveRecipient ?? preparation?.controller ?? finiteWake?.target.controller ?? { machineId: root.data.binding.machineId,
      installationId: root.data.binding.installationId };
    if (recipient.machineId !== input.machineId || recipient.installationId !== input.installationId) return refused('requester_preparation_recipient');
    const regularOwnAccount = isOriginalOwnAccountActionCustody(root.data.binding);
    if (sessionCustody && (!isOriginalSessionInputAccountActionCustody(root.data.binding)
      || input.purpose.kind !== 'external_action' || root.data.binding.target.kind !== 'session'
      || sessionCustody.getBoundSessionId() !== root.data.binding.target.sessionId
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
      ...(sessionCustody ? { onRetire: () => sessionCustody.release() } : {}),
      ...(encoded?.invocation ? { invocation: encoded.invocation } : {}) });
    if (!admitted) return refused('requester_account_admission');
    custodyTransferred = true;
    let phase = 'requester_http_projection';
    try {
      // Named native preparation proves controller custody, not a generic HTTP
      // effect grant for the unchanged guest-targeted original Action.
      const projected = finiteWake || preparation ? admitted.authorization : await trace('requester.http_projection', () => projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: input.serverId, serverIdentityId: input.serverIdentityId, serverHttpBaseUrl: input.serverHttpBaseUrl,
        target: admitted.authorization.binding.target, installationId: input.installationId,
        privateKey: input.installationPrivateKey, isCurrent: admitted.isCustodyCurrent ?? admitted.isCurrent,
        ...(moveRecipient ? { forwardedMove: { credentials: admitted.credentials, isCurrent: admitted.isCurrent } } : {}),
        ...(input.signal ? { signal: input.signal } : {}) }));
      if (!projected) { await admitted.dispose(); return refused(phase); }
      phase = 'requester_executor';
      const executor = input.createExecutor(Object.freeze({ ...admitted, authorization: projected }));
      const authorization: ExternalActionExecutionAuthorizationV1 = { ...projected };
      for (const [key, value] of Object.entries({ requesterAccountProjection: projected.requesterAccountProjection,
        requesterHttpProjection: projected.requesterHttpProjection, requesterAccountExecutor: executor })) {
        if (value) Object.defineProperty(authorization, key, { value, enumerable: false });
      }
      return { authorization: Object.freeze(authorization), executor, dispose: admitted.dispose, resolveEncryption: admitted.resolveEncryption,
        ...(encoded?.invocation ? { invocation: encoded.invocation } : {}) };
    } catch (error) { await admitted.dispose(); rethrowRequesterHomeReadFailure(error); return refused(phase, error); }
  } finally { if (!custodyTransferred) await sessionCustody?.release(); }
}

export type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
export { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

export type RequesterAccountActionCustody = Readonly<{
  credentials: StoredCredentials;
  attribution: RequesterWorkAttributionV1;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
  getBoundSessionId?(): string | null;
}>;

export function readApiTokenDeploymentArtifactStore(authorization?: ExternalActionExecutionAuthorizationV1) {
  return (authorization?.requesterAccountProjection as TokenProjection | undefined)?.[tokenDeploymentArtifacts] ?? null;
}

type TokenProjection = ExternalActionRequesterAccountProjectionV1 & {
  [tokenDeploymentArtifacts]?: ReturnType<typeof createAccountArtifactStore>;
};

const tokenDeploymentArtifacts = Symbol('tokenDeploymentArtifacts');
