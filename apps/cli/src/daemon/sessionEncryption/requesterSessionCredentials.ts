import { CustodySchema, CustodyStoredReadSchema, type RequesterSessionCredentialBinding, requesterSessionCredentialPath, requesterSessionCredentialDirectory, requesterSessionCredentialFilePrefix } from './requesterSessionCustody';
export { REQUESTER_SESSION_CREDENTIAL_FILE_ENV, REQUESTER_SESSION_ID_ENV, type RequesterSessionCredentialBinding, requesterSessionCredentialPath, readRequesterSessionCredentialsForChild } from './requesterSessionCustody';
import { readRequesterHomeWithinActionLifetime, rethrowRequesterHomeReadFailure, requesterCurrentnessCheckpoint, type RequesterCurrentnessObservation } from './requesterCurrentness';

import { basename, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { SessionRequesterBootstrapV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { configuration } from '@/configuration';
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, encodeStoredCredentials, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { fetchAccountProfile } from '@/api/accountProfile';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { acquireRequesterAccountEncryptionCurrentness, readRequesterAccountEncryptionCurrentness, waitForObservation,
  isRequesterAccountEncryptionCurrentnessObserved, sameRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readPrivateOwnerFile, writePrivateOwnerFile, replacePrivateBearerFile, removePrivateBearerFile } from '../privateBearerFile';
import { RequesterWorkAttributionV1Schema, isCustodianMachineAdmission, type RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { ApiClient } from '@/api/api';
import type { ExecuteSpawnSessionRequestParams } from '../startup/executeSpawnSessionRequest';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createRequesterAccountSettingsPublication } from '@/settings/accountSettings/requesterAccountSettingsPublication';
import type { ConnectedServiceQualifiedAuthGroupApi } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { RequesterAccountActionAuthorizationInput } from './requesterAccountActionProjection';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readPublishedMachineRow } from '@/api/machine/readPublishedMachineRow';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { readMachineRpcAdmissionCurrentOrThrow } from '@/api/machine/machineRpcAuthorization';
import { listProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import { logger } from '@/utils/logger';
import { performance } from 'node:perf_hooks';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

import type { TrackedSession } from '../types';
import { readHostAccountExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationAccountCustody';
import { selectHostRequesterExecutionIdentity, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

/** The existing custody owner distinguishes absent private birth from an
 * unreadable/historical source. Current Account ownership never rewrites birth. */
export async function resolveRequesterSessionExecutionIdentityForHost(input: Readonly<{
  happyHomeDir: string; serverId: string; serverHttpBaseUrl: string; sessionId: string; machineId: string;
  hostHomeServerIdentityId: string | null; sessionCustodianAccountId?: string | null;
  credentials: StoredCredentials; attribution?: RequesterWorkAttributionV1;
  runtimeContext: RequesterSessionRuntimeContext | null | undefined;
  isCurrent(): boolean | Promise<boolean>; signal?: AbortSignal;
}>): Promise<HostRequesterExecutionIdentity> {
  const unavailable = (): HostRequesterExecutionIdentity => ({ kind: 'unknown', reason: 'session_requester_unavailable' });
  input.signal?.throwIfAborted();
  try {
    if (!input.hostHomeServerIdentityId || !await input.isCurrent()) return unavailable();
    const runtime = input.runtimeContext;
    if (runtime) {
      const birth = runtime.bootstrap;
      if (birth.getBoundSessionId() !== input.sessionId || input.attribution && !isDeepStrictEqual(input.attribution, birth.attribution)
        || !await runtime.isCurrent(input.signal) || !await input.isCurrent()) return unavailable();
      return selectHostRequesterExecutionIdentity({ sessionRequester: birth.attribution,
        sessionRequesterHomeServerIdentityId: birth.homeServerIdentityId,
        hostHomeServerIdentityId: input.hostHomeServerIdentityId, sessionCustodianAccountId: input.sessionCustodianAccountId });
    }
    if ('requesterSessionCredentialScope' in input.credentials) return unavailable();
    const identity = await readHostAccountExecutionIdentity({ credentials: input.credentials, catalogCredentials: input.credentials,
      kind: 'agent', machineId: input.machineId, hostHomeServerIdentityId: input.hostHomeServerIdentityId,
      serverHttpBaseUrl: input.serverHttpBaseUrl,
      exactSession: { sessionId: input.sessionId, serverId: input.serverId, happyHomeDir: input.happyHomeDir },
      isCurrent: input.isCurrent, signal: input.signal });
    if (identity.kind !== 'isolated' || identity.separationRequired) return unavailable();
    // A public owner launch can retain the original Machine attribution without
    // a private requester birth. It must match the independently qualified
    // physical owner and exact Session; attribution alone never grants custody.
    if (input.attribution && !isDeepStrictEqual(input.attribution, {
      ...identity.requester, serverId: input.serverId,
    })) return unavailable();
    return identity;
  } catch (error) { input.signal?.throwIfAborted(); rethrowRequesterHomeReadFailure(error); return unavailable(); }
}
import { readWebLatencyTracePoint, timeWebLatencyPhase } from "../externalActions/webLatencyTrace";

/** Existing requester projection owner; private Account ports stay on the admitted authorization carrier. */
export async function projectRequesterAccountActionAuthorization(
  input: RequesterAccountActionAuthorizationInput,
): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const projection = await import('./requesterAccountActionProjection');
  return await projection.projectRequesterAccountActionAuthorization(input);
}
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import type { ProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import type { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import type { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';

/** Exact live Session Account ports; owned by ordinary daemon Session lifecycle, never serialized. */
export type RequesterSessionRuntimeContext = Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
  /** One observation of admission, custody and retirement; signal cancels, never selects retry policy. */
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  api: ApiClient;
  sessionFollowRuleCache: ReturnType<typeof import('@/agent/runtime/session/follow/accountSessionFollowRuleCache').createAccountSessionFollowRuleCache>;
  /** The incumbent daemon observer binds the exact destination's source wake. */
  bindSessionFollowSourceReconciliation(reconcile: (sourceSessionId: string | null) => Promise<void>, signal: AbortSignal): void;
  readAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot;
  readAccountLaunchProfiles(): Promise<Awaited<ReturnType<typeof import('@/settings/profiles/readProfilesFromAccountSettings').readAccountLaunchProfiles>>>;
  subscribeAccountSettingsSnapshot(listener: () => void): () => void;
  qualifiedConnectedAccountApi: ConnectedServiceQualifiedAuthGroupApi;
  qualifiedConnectedAccountEstablishedRuntimeOwner: QualifiedConnectedAccountEstablishedRuntimeOwner;
  connectedAccountsOwner: StablePluginConnectedAccountsOwner;
  resolveCurrentRequestAuthBinding: DaemonConnectedAccountPurposeBindingRuntime['resolveCurrentRequestAuthBinding'];
  materializeRequestAuthBearer: DaemonConnectedAccountPurposeBindingRuntime['materializeRequestAuthBearer'];
  resolveCurrentSessionPurposeBindingSnapshot: DaemonConnectedAccountPurposeBindingRuntime['resolveCurrentSessionPurposeBindingSnapshot'];
  daemonSessionMutationCustody: DaemonSessionMutationCustody;
  refreshAccountSettings(minSettingsVersion?: number, signal?: AbortSignal): Promise<boolean>;
  activeServerDir: string;
  connectedServicesMaterializationBaseDir: string;
  connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  providerAccountUsagePersistence: ProviderAccountUsagePersistenceScheduler;
  providerAccountUsageStore: ReturnType<typeof createProviderAccountUsageStore>;
  connectedServiceRuntimeRegistry: ReturnType<ConnectedServiceRuntimeRegistry['scopeToRequester']>;
  dispose(): Promise<void>;
}> & Pick<ExecuteSpawnSessionRequestParams,
  'connectedServiceRefreshCoordinator' | 'connectedServiceQuotasCoordinator'
  | 'authGroupSwitchCoordinator' | 'predictiveSwitchGuard' | 'resolveManagedPurposeBindingIntent'
  | 'activateSessionPurposeBindings' | 'activatePurposeBindings'>;

export type ResolveRequesterSessionRuntimeContext = (
  sessionId: string, attribution?: RequesterWorkAttributionV1, signal?: AbortSignal,
  onPreparationRefused?: (bootstrap: AdmittedRequesterSessionBootstrap) => Promise<void>,
) => Promise<RequesterSessionRuntimeContext | null>;

/** The daemon's one tracked/recovered requester selection and publication owner. */
export function createRequesterSessionRuntimeContextResolver(input: Readonly<{
  trackedSessions: ReadonlyMap<number, TrackedSession>;
  getCreateRuntime(): ((bootstrap: AdmittedRequesterSessionBootstrap, signal?: AbortSignal) => Promise<RequesterSessionRuntimeContext | null>) | null;
  recoverBootstrap(input: Readonly<{ sessionId: string; attribution?: RequesterWorkAttributionV1; tracked: boolean; signal?: AbortSignal;
    onSessionReadRefused?: () => void }>): Promise<AdmittedRequesterSessionBootstrap | null>;
}>): ResolveRequesterSessionRuntimeContext {
  const pidToTrackedSession = input.trackedSessions;
  return async (sessionId, attribution, signal, onPreparationRefused) => {
    if (signal?.aborted) return null;
    // Exited runners no longer lend requester authority. Inactive operations
    // still recover their own temporary context through the same custody path.
    const tracked = [...pidToTrackedSession.values()].find(candidate => candidate.happySessionId === sessionId
      && candidate.reportMarkerCustody?.retiring !== true);
    const context = tracked?.requesterSessionRuntimeContext;
    if (!context && !input.getCreateRuntime()) return null;
    let stamp = tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1
      ?? context?.bootstrap.attribution ?? attribution;
    if (stamp && attribution && !isDeepStrictEqual(stamp, attribution)) return null;
    let sessionReadRefused = false;
    const recoverBootstrap = (observeRefusal = true) => input.recoverBootstrap({ sessionId, ...(stamp ? { attribution: stamp } : {}), tracked: tracked !== undefined,
      ...(signal ? { signal } : {}),
      ...(onPreparationRefused && observeRefusal ? { onSessionReadRefused: () => { sessionReadRefused = true; } } : {}) });
    const settlePreparationRefusal = async () => {
      if (!sessionReadRefused || !onPreparationRefused || signal?.aborted) return;
      // A failed read is not authority. Only a newly verified bootstrap may
      // report that refusal; persistent unreadability keeps activation waiting.
      const current = await recoverBootstrap(false);
      if (!current) return;
      try { if (!signal?.aborted && await current.isCurrent(signal)) await onPreparationRefused(current); }
      finally { await current.dispose(); }
    };
    const coldBootstrap = !context ? await recoverBootstrap() : null;
    stamp ??= coldBootstrap?.attribution;
    if (!stamp) { await settlePreparationRefusal(); return null; }
    const stillOwnsTrackedContext = (expected: RequesterSessionRuntimeContext | undefined): boolean => {
      const currentStamp = tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1;
      return tracked !== undefined && tracked.requesterSessionRuntimeContext === expected
        && tracked.reportMarkerCustody?.retiring !== true
        && [...pidToTrackedSession.values()].some(candidate => candidate === tracked && candidate.happySessionId === sessionId)
        && (!currentStamp || isDeepStrictEqual(currentStamp, stamp));
    };
    if (context) {
      const contextStamp = context.bootstrap.attribution;
      if (contextStamp.serverId !== stamp.serverId || contextStamp.accountId !== stamp.accountId
        || contextStamp.machineId !== stamp.machineId || contextStamp.installationId !== stamp.installationId
        || context.bootstrap.getBoundSessionId() !== sessionId) return null;
      if (await context.isCurrent(signal)) {
        if (tracked && !stillOwnsTrackedContext(context)) return null;
        if (tracked) tracked.requesterWorkAttributionV1 = stamp;
        return context;
      }
    }
    if (signal?.aborted) return null;
    const createRequesterRuntime = input.getCreateRuntime();
    if (!createRequesterRuntime) return null;
    const bootstrap = context ? await recoverBootstrap() : coldBootstrap;
    if (!bootstrap) { await settlePreparationRefusal(); return null; }
    const recovered = await createRequesterRuntime(bootstrap, signal);
    if (!recovered) { bootstrap.savedSecretOperationContext.withdrawCatalog(); return null; }
    if (tracked) {
      const stillTracked = tracked.reportMarkerCustody?.retiring !== true && [...pidToTrackedSession.values()].some(candidate => candidate === tracked
        && candidate.happySessionId === sessionId);
      if (!stillTracked) { await recovered.dispose(); return null; }
      const incumbent = tracked.requesterSessionRuntimeContext;
      if (incumbent && incumbent !== context) {
        await recovered.dispose();
        const incumbentStamp = incumbent.bootstrap.attribution;
        return incumbentStamp.serverId === stamp.serverId && incumbentStamp.accountId === stamp.accountId
          && incumbentStamp.machineId === stamp.machineId && incumbentStamp.installationId === stamp.installationId
          && incumbent.bootstrap.getBoundSessionId() === sessionId
          && await incumbent.isCurrent(signal) && stillOwnsTrackedContext(incumbent) ? incumbent : null;
      }
      if (!await recovered.isCurrent(signal) || !stillOwnsTrackedContext(context)) {
        await recovered.dispose(); return null;
      }
      tracked.requesterSessionRuntimeContext = recovered;
      tracked.requesterWorkAttributionV1 = stamp;
      if (context) await releaseUnretainedRequesterSessionRuntimeContext(context,
        [...pidToTrackedSession.values()].map(candidate => candidate.requesterSessionRuntimeContext));
    }
    return recovered;
  };
}

export type ReleaseRequesterSessionRuntimeContext = (context: RequesterSessionRuntimeContext) => Promise<void>;

/** A tracked runner owns its exact requester; other acquisitions are temporary. */
export async function releaseUnretainedRequesterSessionRuntimeContext(
  context: RequesterSessionRuntimeContext,
  retainedContexts: Iterable<RequesterSessionRuntimeContext | null | undefined>,
): Promise<void> {
  for (const retained of retainedContexts) if (retained === context) return;
  await context.dispose();
}

/** Recovery can return a borrowed tracked runtime or a temporary operation owner. */
export type RequesterSessionRuntimeContextPorts =
  | Readonly<{
    resolveRequesterSessionRuntimeContext: ResolveRequesterSessionRuntimeContext;
    releaseRequesterSessionRuntimeContext: ReleaseRequesterSessionRuntimeContext;
  }>
  | Readonly<{
    resolveRequesterSessionRuntimeContext?: undefined;
    releaseRequesterSessionRuntimeContext?: undefined;
  }>;

/** Canonical Session Account assertion used by the daemon's captured operation context. */
export async function assertRequesterSessionAccountContextCurrent(input: Readonly<{
  expected: RequesterSessionRuntimeContext | null;
  signal?: AbortSignal;
  resolveCurrent(): Promise<RequesterSessionRuntimeContext | null>;
  readTrackedContext(): RequesterSessionRuntimeContext | null;
}>): Promise<void> {
  if (input.expected) {
    const tracked = input.readTrackedContext();
    if (tracked && tracked !== input.expected || !await input.expected.isCurrent(input.signal)) {
      throw new Error('requester_session_not_current');
    }
    return;
  }
  const current = await input.resolveCurrent();
  if (!current) return;
  await releaseUnretainedRequesterSessionRuntimeContext(current, [input.readTrackedContext()]);
  throw new Error('requester_session_not_current');
}

/** Created by the receiving host after admission; never accepted from decrypted caller input. */
export type AdmittedRequesterSessionBootstrap = Readonly<{
  credentials: StoredCredentials;
  /** Host-verified Machine custodian identity; caller origin never grants native credentials. */
  allowNativeAccountCredentials: boolean;
  preparedSessionId?: string;
  attribution: RequesterWorkAttributionV1;
  /** Actual Home observed at admission; the saved profile remains attribution.serverId. */
  homeServerIdentityId?: string;
  serverHttpBaseUrl: string;
  accountSettingsContext: AccountSettingsContext;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  ensureAccountSettingsCurrent(signal?: AbortSignal): Promise<boolean>;
  refreshAccountSettings(minSettingsVersion?: number, signal?: AbortSignal): Promise<boolean>;
  subscribeAccountSettings(listener: () => void): () => void;
  subscribeSessionFollowRules(listener: () => void): () => void;
  subscribeConnectedAccounts: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness>['subscribeConnectedAccounts'];
  subscribeSessionFollowSources(listener: (sourceSessionId: string | null) => void): () => void;
  /** One authority observation; accepted preparation owns any retry outside this reader. */
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  /** Retires this bootstrap's observation when its ordinary runtime lifetime ends. */
  dispose(): Promise<void>;
  getBoundSessionId(): string | null;
  /** Installed by the ordinary daemon runtime owner, never by transported caller input. */
  bindRuntimeMachineAdmissionCurrentness(verify: (signal?: AbortSignal) => Promise<boolean>): void;
  projectExternalActionAuthorization(authorization: ExternalActionExecutionAuthorizationV1,
    observedServerIdentityId: string, signal?: AbortSignal): Promise<ExternalActionExecutionAuthorizationV1 | null>;
  bindSession(sessionId: string, sessionCreationTag: string): Promise<Readonly<{ path: string; cleanup(): Promise<void> }> | null>;
  /** Existing-Session adoption retains the original immutable creation recipe. */
  bindExistingSession(sessionId: string): Promise<Readonly<{ path: string; cleanup(): Promise<void> }> | null>;
}>;

export async function admitRequesterSessionBootstrap(input: Readonly<{
  bootstrap: SessionRequesterBootstrapV1;
  boundary: Readonly<{ serverId: string; serverHttpBaseUrl: string; happyHomeDir: string;
    getObservedServerIdentityId?(): string | null | Promise<string | null> }>;
  context: RpcHandlerContext;
  /** Existing ordinary Session received by the host handoff ingress, never a creation recipe rewrite. */
  existingSessionId?: string;
}>): Promise<Readonly<{ admitted: AdmittedRequesterSessionBootstrap; cleanupOnFailure(): Promise<void> }> | null> {
  const admission = input.context.machineAdmission;
  const verify = input.context.verifyMachineAdmissionCurrent;
  const credentials = decodeStoredCredentials(input.bootstrap.credentials);
  if (!admission || !verify || !credentials || input.context.signal.aborted) return null;
  const signedHome = input.context.callerInputAuthorization?.binding.serverIdentityId;
  const homeServerIdentityId = input.boundary.getObservedServerIdentityId
    ? await input.boundary.getObservedServerIdentityId() : signedHome;
  if (signedHome && homeServerIdentityId !== signedHome) return null;
  const attribution = RequesterWorkAttributionV1Schema.parse({ serverId: input.boundary.serverId,
    accountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId });
  const preparedSessionId = 'sessionId' in input.bootstrap ? input.bootstrap.sessionId : undefined;
  return await readRequesterHomeWithinActionLifetime(() => prepareRequesterSessionBootstrap({ credentials, attribution, boundary: input.boundary,
    machineAdmission: admission, ...(homeServerIdentityId ? { homeServerIdentityId } : {}),
    verifyMachineAdmissionCurrent: verify, signal: input.context.signal,
    ...(input.existingSessionId ? { preparedSessionId: input.existingSessionId, boundSessionId: input.existingSessionId } : {}),
    ...(preparedSessionId ? { preparedSessionId } : {}) }), input.context.signal);
}

export async function prepareRequesterSessionBootstrap(input: Readonly<{
  homeServerIdentityId?: string;
  machineAdmission?: SavedSecretOperationContextV1['machineAdmission'];
  credentials: StoredCredentials;
  attribution: RequesterWorkAttributionV1;
  boundary: Readonly<{ serverId: string; serverHttpBaseUrl: string; happyHomeDir: string }>;
  verifyMachineAdmissionCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
  preparedSessionId?: string;
  boundSessionId?: string;
}>): Promise<Readonly<{ admitted: AdmittedRequesterSessionBootstrap; cleanupOnFailure(): Promise<void> }> | null> {
  const { attribution, preparedSessionId } = input;
  // Session custody borrows the installed/parent credential. Its private
  // scope must not mutate that owner's identity, and an existing private
  // scope must remain binding on the borrowed copy.
  const credentials = Object.defineProperties({ ...input.credentials }, Object.getOwnPropertyDescriptors(input.credentials));
  const machineAdmission = input.machineAdmission ? Object.freeze({
    actorAccountId: input.machineAdmission.actorAccountId, custodianAccountId: input.machineAdmission.custodianAccountId,
    role: input.machineAdmission.role,
  }) : undefined;
  const verify = input.verifyMachineAdmissionCurrent;
  let bound: Readonly<{ sessionId: string; sessionCreationTag?: string }> | null = input.boundSessionId
    ? { sessionId: input.boundSessionId } : null;
  let verifyRuntime = input.boundSessionId ? verify : null;
  let observation: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | undefined;
  let admitted = false;
  let live = true;
  const lifetime = new AbortController();
  // A bound Session outlives its launch RPC, but never its bootstrap.
  const launchSignal = input.signal ? AbortSignal.any([lifetime.signal, input.signal]) : lifetime.signal;
  const currentnessSignal = () => bound ? lifetime.signal : launchSignal;
  const observationScope = { accountId: attribution.accountId, token: credentials.token,
    serverBaseUrl: input.boundary.serverHttpBaseUrl };
  try {
    const readAccountCurrentness = async (signal = currentnessSignal()) => await runWithServerHttpBaseUrl(input.boundary.serverHttpBaseUrl, async () => {
      if (!live || signal.aborted || !await verify(signal)) return null;
      const profile = await fetchAccountProfile({ token: credentials.token, signal });
      if (profile.id !== attribution.accountId || !live || signal.aborted) return null;
      observation ??= acquireRequesterAccountEncryptionCurrentness(observationScope);
      const currentness = await observation.read(signal);
      return (currentness.mode === 'plain' ? credentials.encryption === null : credentials.encryption !== null)
        && live && !signal.aborted && await verify(signal)
        && observation.isCurrent(currentness) ? currentness : null;
    });
    const currentness = await readAccountCurrentness(launchSignal);
    if (!currentness || !observation) return null;
    const accountObservation = observation;
    bindRequesterSessionCredentialScope(credentials, { serverId: attribution.serverId,
      serverHttpBaseUrl: normalizeServerHttpBaseUrl(input.boundary.serverHttpBaseUrl) });
    let cleanup: () => Promise<void> = async () => undefined;
    // Admission already reads a fresh authority witness. Retain its Settings
    // minimum only until bootstrap; an idle encryption identity has no cursor.
    let initializationSettingsWitness: { settingsVersion?: number } | undefined = {};
    const observeCurrent = async () => {
      // This is a fresh Home-authority decision, not a cached encryption-identity
      // read. A mode/key transition may precede its socket invalidation.
      const fresh = await fetchAccountEncryptionCurrentness({ token: credentials.token,
        serverBaseUrl: input.boundary.serverHttpBaseUrl, signal: currentnessSignal() });
      if (!sameRequesterAccountEncryptionCurrentness(fresh, currentness)) return false;
      if (initializationSettingsWitness) initializationSettingsWitness.settingsVersion = fresh.settingsVersion;
      // Creation correspondence is proven around custody binding below. Once
      // bound, use the same fresh Session authority checks as cold recovery;
      // reopening immutable owner metadata at every credential fence adds no
      // runtime authority and needlessly repeats its decryption.
      const current = bound
      ? verifyRuntime !== null && await verifyRequesterSessionCredentialBinding({ credentials, sessionId: bound.sessionId, attribution,
        serverHttpBaseUrl: input.boundary.serverHttpBaseUrl,
        verifyMachineAdmissionCurrent: verifyRuntime, signal: currentnessSignal() })
      : await readAccountCurrentness().then(next => next !== null && sameRequesterAccountEncryptionCurrentness(next, currentness));
      return current && await isObservationCurrent();
    };
    // Ordinary readers share only an outstanding Home verification. Native
    // checkpoints also share its result until their next effect boundary.
    let currentObservation: RequesterCurrentnessObservation | undefined;
    let currentnessKey = {};
    const isObservationCurrent = async () => {
      if (!live || currentnessSignal().aborted) return false;
      if (isRequesterAccountEncryptionCurrentnessObserved(observationScope, currentness)) return true;
      // Missing live evidence is not revocation. The observation owner
      // distinguishes unavailable transport from a known changed Account fact.
      const observed = await accountObservation.read(currentnessSignal());
      return live && !currentnessSignal().aborted && sameRequesterAccountEncryptionCurrentness(observed, currentness);
    };
    const readCurrentness = async () => {
      if (!await isObservationCurrent()) return false;
      const checkpoint = requesterCurrentnessCheckpoint.getStore();
      const read = (observed: RequesterCurrentnessObservation) => observed.pending
        .then(current => current && isObservationCurrent()).catch(error => {
          if (checkpoint?.observations.get(currentnessKey) === observed) checkpoint.observations.delete(currentnessKey);
          throw error;
        });
      const shared = checkpoint?.active ? checkpoint.observations.get(currentnessKey) : undefined;
      if (shared) return timeWebLatencyPhase('requester.currentness_reuse',
        () => read(shared), shared.trace);
      const reused = currentObservation;
      if (!currentObservation) {
        const pending = observeCurrent().finally(() => {
          if (currentObservation?.pending === pending) currentObservation = undefined;
        });
        currentObservation = { pending, trace: readWebLatencyTracePoint() };
      }
      if (checkpoint?.active) checkpoint.observations.set(currentnessKey, currentObservation);
      const observed = currentObservation;
      return reused ? timeWebLatencyPhase('requester.currentness_reuse', () => read(observed), reused.trace) : read(observed);
    };
    const isCurrent = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return await (signal ? waitForObservation(readCurrentness(), signal) : readCurrentness());
    };
    const readPreparationCurrentness = () => isCurrent(input.signal);
    if (!await readPreparationCurrentness()) return null;
    const accountSettingsContext = await runWithServerHttpBaseUrl(input.boundary.serverHttpBaseUrl,
      () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
        signal: launchSignal, allowCacheFallback: false,
        expectedAccountEncryptionMode: currentness.mode, honorAccountSettingsModeEnv: false,
        minSettingsVersion: initializationSettingsWitness?.settingsVersion,
        shouldCommit: () => !input.signal?.aborted }));
    initializationSettingsWitness = undefined;
    if (accountSettingsContext.source !== 'network' || !await readPreparationCurrentness()) return null;
    const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials,
      machineAdmission,
      snapshot: accountSettingsContext, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl, isCurrent });
    const settingsPublication = createRequesterAccountSettingsPublication({ observation: accountObservation, currentness, operationContext: savedSecretOperationContext });
    const dispose = async () => {
      live = false;
      lifetime.abort();
      settingsPublication.dispose();
      savedSecretOperationContext.withdrawCatalog();
      await savedSecretOperationContext.isCurrent();
      await observation?.dispose();
    };
    const persistVerifiedCustody = async (binding: Parameters<typeof verifyRequesterSessionCredentialBinding>[0]) => {
      if (!await verifyRequesterSessionCredentialBinding(binding)) return null;
      await bindRequesterSessionMachineControl(binding);
      if (!await verifyRequesterSessionCredentialBinding(binding)) return null;
      return await createRequesterSessionCredentialCustody({ ...binding, happyHomeDir: input.boundary.happyHomeDir,
        ...(machineAdmission ? { machineAdmission } : {}),
        ...(input.homeServerIdentityId ? { homeServerIdentityId: input.homeServerIdentityId } : {}) });
    };
    const bindSession: AdmittedRequesterSessionBootstrap['bindSession'] = async (sessionId, sessionCreationTag) => {
      if (!verifyRuntime || preparedSessionId && preparedSessionId !== sessionId || bound && (bound.sessionId !== sessionId
        || bound.sessionCreationTag !== undefined && bound.sessionCreationTag !== sessionCreationTag) || !await isCurrent()) return null;
      const binding = { credentials, sessionId, attribution, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl,
        verifyMachineAdmissionCurrent: bound ? verifyRuntime : verify,
        signal: currentnessSignal(), expectedSessionCreationTag: sessionCreationTag };
      const custody = await persistVerifiedCustody(binding);
      if (!custody) return null;
      bound = { sessionId, sessionCreationTag };
      currentObservation = undefined;
      currentnessKey = {};
      cleanup = custody.cleanup;
      if (!await isCurrent()) { await cleanup(); return null; }
      return { path: custody.path, cleanup };
    };
    const bindExistingSession: AdmittedRequesterSessionBootstrap['bindExistingSession'] = async sessionId => {
      if (!bound || bound.sessionId !== sessionId || !verifyRuntime || !await isCurrent()) return null;
      const binding = { credentials, sessionId, attribution, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl,
        verifyMachineAdmissionCurrent: verifyRuntime, signal: currentnessSignal() };
      const custody = await persistVerifiedCustody(binding);
      if (!custody) return null;
      cleanup = custody.cleanup;
      if (!await isCurrent()) { await cleanup(); return null; }
      return { path: custody.path, cleanup };
    };
    const projectionBootstrap = { credentials, attribution, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl, isCurrent,
      getBoundSessionId: () => bound?.sessionId ?? null };
    const projectExternalActionAuthorization: AdmittedRequesterSessionBootstrap['projectExternalActionAuthorization'] =
      async (authorization, observedServerIdentityId, signal) => await projectRequesterAccountActionAuthorization({
        authorization, serverIdentityId: observedServerIdentityId, bootstrap: projectionBootstrap,
        ...(signal ? { signal } : {}),
      });
    admitted = true;
    return { admitted: Object.freeze({ credentials, ...(preparedSessionId ? { preparedSessionId } : {}),
      allowNativeAccountCredentials: machineAdmission?.actorAccountId === attribution.accountId
        && isCustodianMachineAdmission(machineAdmission),
      attribution, ...(input.homeServerIdentityId ? { homeServerIdentityId: input.homeServerIdentityId } : {}),
      serverHttpBaseUrl: input.boundary.serverHttpBaseUrl, accountSettingsContext,
      savedSecretOperationContext, isCurrent, dispose, getBoundSessionId: () => bound?.sessionId ?? null, bindSession, bindExistingSession,
      ensureAccountSettingsCurrent: settingsPublication.ensureCurrent, subscribeAccountSettings: settingsPublication.subscribe,
      subscribeSessionFollowRules: accountObservation.subscribeSessionFollowRules,
      subscribeConnectedAccounts: accountObservation.subscribeConnectedAccounts,
      subscribeSessionFollowSources: accountObservation.subscribeSessionFollowSources,
      refreshAccountSettings: settingsPublication.refresh,
      bindRuntimeMachineAdmissionCurrentness: (current: (signal?: AbortSignal) => Promise<boolean>) => {
        verifyRuntime = current;
        currentObservation = undefined;
        currentnessKey = {};
      },
      projectExternalActionAuthorization,
    }),
      cleanupOnFailure: async () => {
        await dispose();
        await cleanup();
      } };
  } catch (error) {
    rethrowRequesterHomeReadFailure(error);
    throw error;
  } finally {
    if (!admitted) { live = false; lifetime.abort(); await observation?.dispose(); }
  }
}

/** Daemon credentials sign installation proofs only; requester content always uses the protected requester bearer. */
export type RequesterSessionMachineAdmissionBoundary = Readonly<{
  machineId: string;
  daemonToken: string;
  signal?: AbortSignal;
  isHomeCurrent(): boolean;
  getObservedServerIdentityId?(): string | null | Promise<string | null>;
  readInstallation(): Readonly<{ installationId: string; privateKey: string | Uint8Array }> | null;
}>;

// Discovery belongs to one binding invocation, including opaque ingress
// callbacks that reach this same Machine owner. It never retains authority:
// both Machine checks still sign and ask Home, and every later binding discovers
// its context anew. Exact identity matching prevents another callback borrowing it.
type RequesterBindingDiscovery = {
  active: boolean;
  binding: Readonly<{ credentials: StoredCredentials; sessionId: string;
    attribution: RequesterWorkAttributionV1; serverHttpBaseUrl: string }>;
  context?: NonNullable<RpcHandlerContext['machineAdmission']>;
};
const requesterBindingDiscovery = new AsyncLocalStorage<RequesterBindingDiscovery>();

/** Runtime authority follows custody binding, not a prepared Session id or the completed launch RPC. */
export function bindRequesterSessionRuntimeMachineAdmissionCurrentness(input: Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
  boundary: RequesterSessionMachineAdmissionBoundary;
}>): void {
  const { bootstrap, boundary } = input;
  bootstrap.bindRuntimeMachineAdmissionCurrentness(async signal => {
    const sessionId = bootstrap.getBoundSessionId();
    if (sessionId === null) return false;
    return await verifyRequesterSessionMachineAdmissionCurrent({
      credentials: bootstrap.credentials, attribution: bootstrap.attribution, sessionId,
      serverHttpBaseUrl: bootstrap.serverHttpBaseUrl, boundary, signal,
    });
  });
}

/** Account-authenticated Machine admission has no Session dependency. The optional
 * id only correlates discovery within the existing custody binding invocation. */
export async function readRequesterMachineAdmissionCurrent(input: Readonly<{
  credentials: StoredCredentials;
  sessionId?: string;
  attribution: RequesterWorkAttributionV1;
  serverHttpBaseUrl: string;
  boundary: RequesterSessionMachineAdmissionBoundary;
  signal?: AbortSignal;
}>): Promise<NonNullable<RpcHandlerContext['machineAdmission']> | null | undefined> {
  return await timeWebLatencyPhase('requester.machine_verification', async () => {
    try {
      const signal = input.signal && input.boundary.signal
        ? AbortSignal.any([input.signal, input.boundary.signal]) : input.signal ?? input.boundary.signal;
      if (signal?.aborted) return undefined;
      const installation = input.boundary.readInstallation();
      if (!input.boundary.isHomeCurrent() || input.attribution.machineId !== input.boundary.machineId
        || installation?.installationId !== input.attribution.installationId) return undefined;
      const scope = requesterBindingDiscovery.getStore();
      const discovery = scope?.active && scope.binding.credentials.token === input.credentials.token
        && scope.binding.sessionId === input.sessionId && isDeepStrictEqual(scope.binding.attribution, input.attribution)
        && normalizeServerHttpBaseUrl(scope.binding.serverHttpBaseUrl) === normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)
        ? scope : undefined;
      let context = discovery?.context;
      if (!context) {
        const [profile, machine] = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => Promise.all([
          timeWebLatencyPhase('requester.machine_profile', () => fetchAccountProfile({ token: input.credentials.token, signal })),
          timeWebLatencyPhase('requester.machine_access', () => readPublishedMachineRow(input.attribution.machineId, input.credentials, { signal })),
        ]));
        const access = machine?.access;
        if (profile.id !== input.attribution.accountId || !machine
          || machine.id !== input.attribution.machineId
          || machine.installationId !== installation.installationId || machine.revokedAt != null || machine.replacedByMachineId != null) return null;
        if (access?.accessState === 'refused') return null;
        if (!access || access.accessState !== 'ready') return undefined;
        if (!input.boundary.isHomeCurrent()
          || input.boundary.readInstallation()?.installationId !== installation.installationId) return undefined;
        context = { actorAccountId: profile.id,
          custodianAccountId: access.custodian.accountId, machineId: input.attribution.machineId,
          installationId: installation.installationId, role: access.role,
          encryptionMode: access.resourceMode };
      }
      if (signal?.aborted || !input.boundary.isHomeCurrent()
        || input.boundary.readInstallation()?.installationId !== installation.installationId) return undefined;
      if (discovery) discovery.context = context;
      return context;
    } catch (error) {
      rethrowRequesterHomeReadFailure(error);
      return classifyServerEndpointError(error).kind === 'auth_failed' ? null : undefined;
    }
  });
}

/** Session custody additionally proves its actual Session/AccessKey binding. */
async function readRequesterSessionMachineAdmissionCurrent(input: Parameters<typeof readRequesterMachineAdmissionCurrent>[0]
  & Readonly<{ sessionId: string }>): Promise<NonNullable<RpcHandlerContext['machineAdmission']> | null | undefined> {
  try {
    const signal = input.signal && input.boundary.signal
      ? AbortSignal.any([input.signal, input.boundary.signal]) : input.signal ?? input.boundary.signal;
    const installation = input.boundary.readInstallation();
    if (!installation || signal?.aborted) return undefined;
    const context = await readRequesterMachineAdmissionCurrent(input);
    if (context == null) return context;
    const current = await timeWebLatencyPhase('requester.machine_signed_verification', () => readMachineRpcAdmissionCurrentOrThrow({ context,
      purpose: { kind: 'requester_session_currentness', sessionId: input.sessionId },
      privateKey: installation.privateKey, daemonToken: input.boundary.daemonToken, serverHttpBaseUrl: input.serverHttpBaseUrl, signal }));
    if (signal?.aborted || !input.boundary.isHomeCurrent()
      || input.boundary.readInstallation()?.installationId !== installation.installationId) return undefined;
    return current === null ? null : context;
  } catch (error) {
    rethrowRequesterHomeReadFailure(error);
    return classifyServerEndpointError(error).kind === 'auth_failed' ? null : undefined;
  }
}

export async function verifyRequesterSessionMachineAdmissionCurrent(
  input: Parameters<typeof readRequesterSessionMachineAdmissionCurrent>[0],
): Promise<boolean> {
  return await readRequesterSessionMachineAdmissionCurrent(input) != null;
}


async function readWorkspaceSyncMachineAdmissionCurrent(input: Parameters<typeof readRequesterSessionMachineAdmissionCurrent>[0]) {
  const current = await readRequesterMachineAdmissionCurrent(input);
  if (current === undefined) throw new PluginError({ code: 'project_requester_home_unavailable', retryable: true,
    message: 'Requester Home is temporarily unavailable. Retry when it is available.' });
  return current;
}

/** A captured native TARGET needs current Machine access, never a fictional Session proof. */
export async function verifyWorkspaceSyncRelationshipMachineAdmissionCurrent(
  input: Parameters<typeof readRequesterSessionMachineAdmissionCurrent>[0],
): Promise<boolean> {
  return await readWorkspaceSyncMachineAdmissionCurrent(input) !== null;
}

/** SOURCE has no captured native member. A fresh boundary must still permit
 * this exact requester to execute through the installed daemon. */
export async function verifyWorkspaceSyncSourceMachineAdmissionCurrent(
  input: Parameters<typeof readRequesterSessionMachineAdmissionCurrent>[0],
): Promise<boolean> {
  const current = await readWorkspaceSyncMachineAdmissionCurrent(input);
  return current != null && (isCustodianMachineAdmission(current) || current.role === 'manage');
}

/** Reconstructs Account ports for this exact Session; protected custody is data, never an authority witness. */
export async function resolveRequesterSessionBootstrap(input: RequesterSessionCredentialBinding & Readonly<{
  serverHttpBaseUrl: string;
  machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary;
  signal?: AbortSignal;
  onSessionReadRefused?: () => void;
}>): Promise<AdmittedRequesterSessionBootstrap | null> {
  try {
    const stored = await readBoundCustody(requesterSessionCredentialPath(input), input);
    if (!stored) return null;
    let machineAdmission: NonNullable<RpcHandlerContext['machineAdmission']> | undefined;
    const read = (credentials: StoredCredentials) => async (signal?: AbortSignal) => {
      const current = await readRequesterSessionMachineAdmissionCurrent({ credentials, sessionId: input.sessionId,
        attribution: input.attribution, serverHttpBaseUrl: input.serverHttpBaseUrl, boundary: input.machineAdmissionBoundary, signal });
      machineAdmission = current ?? undefined;
      return current;
    };
    const verify = (credentials: StoredCredentials) => async (signal?: AbortSignal) => {
      const current = await read(credentials)(signal);
      // Local Home/installation changes and unreadable responses are not revocation.
      if (current === undefined) throw new Error('requester_session_machine_admission_unavailable');
      return current !== null;
    };
    const credentials = (await resolveRequesterSessionCustody(input, read(stored.credentials)))?.credentials ?? null;
    if (!credentials) return null;
    const result = await prepareRequesterSessionBootstrap({ credentials, attribution: input.attribution, machineAdmission,
      ...(stored.homeServerIdentityId ? { homeServerIdentityId: stored.homeServerIdentityId } : {}),
      boundary: { serverId: input.attribution.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl, happyHomeDir: input.happyHomeDir },
      preparedSessionId: input.sessionId, boundSessionId: input.sessionId, verifyMachineAdmissionCurrent: verify(credentials), signal: input.signal });
    return result?.admitted ?? null;
  } catch (error) { rethrowRequesterHomeReadFailure(error); return null; }
}

/** Cold recovery uses exact protected custody, or fresh authenticated ownership of a legacy Session without custody. */
export async function resolveRequesterSessionBootstrapFromCustody(input: Readonly<{
  happyHomeDir: string; serverId: string; sessionId: string; serverHttpBaseUrl: string;
  machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary;
  legacyOwnerCredentials?: StoredCredentials;
  expectedAttribution?: RequesterWorkAttributionV1;
  signal?: AbortSignal;
  onSessionReadRefused?: () => void;
}>): Promise<AdmittedRequesterSessionBootstrap | null> {
  const boundary = input.machineAdmissionBoundary;
  const installation = boundary.readInstallation();
  const expected = input.expectedAttribution;
  if (!installation || !boundary.isHomeCurrent()
    || expected && (expected.serverId !== input.serverId || expected.machineId !== boundary.machineId
      || expected.installationId !== installation.installationId)) return null;
  if (expected) {
    // Known custody remains an exact read. Unrelated unreadable references
    // cannot withdraw this Session's authority or trigger a credential fallback.
    try {
      await readPrivateOwnerFile(requesterSessionCredentialPath({ ...input, attribution: expected }));
      return await resolveRequesterSessionBootstrap({ ...input, attribution: expected });
    } catch (error) {
      rethrowRequesterHomeReadFailure(error);
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') return null;
    }
  } else {
    const existing = await listRequesterSessionCredentialBindings({ happyHomeDir: input.happyHomeDir,
      serverId: input.serverId, machineId: boundary.machineId, installationId: installation.installationId });
    if (existing.status !== 'ready' || !boundary.isHomeCurrent()
      || boundary.readInstallation()?.installationId !== installation.installationId) return null;
    const binding = existing.bindings.find(candidate => candidate.sessionId === input.sessionId);
    if (binding) return await resolveRequesterSessionBootstrap({ ...input, attribution: binding.attribution });
  }
  if (!input.legacyOwnerCredentials) return null;
  try {
    const credentials = { ...input.legacyOwnerCredentials };
    const profile = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl,
      () => fetchAccountProfile({ token: credentials.token, signal: input.signal }));
    const attribution = { serverId: input.serverId, accountId: profile.id,
      machineId: boundary.machineId, installationId: installation.installationId };
    if (expected && !isDeepStrictEqual(expected, attribution)) return null;
    // An existing foreign/stale reference is not absence and cannot be replaced by
    // the daemon's credentials. Only a genuinely missing legacy reference qualifies.
    const path = requesterSessionCredentialPath({ ...input, attribution });
    try { await readPrivateOwnerFile(path); return null; }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') return null; }
    const machineAdmission = await readRequesterSessionMachineAdmissionCurrent({ credentials,
      sessionId: input.sessionId, attribution, serverHttpBaseUrl: input.serverHttpBaseUrl, boundary, signal: input.signal });
    if (!machineAdmission) return null;
    const verifyMachineAdmissionCurrent = (signal?: AbortSignal) => verifyRequesterSessionMachineAdmissionCurrent({ credentials,
      sessionId: input.sessionId, attribution, serverHttpBaseUrl: input.serverHttpBaseUrl, boundary, signal });
    const prepared = await prepareRequesterSessionBootstrap({ credentials, attribution, machineAdmission,
      boundary: { serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl, happyHomeDir: input.happyHomeDir },
      boundSessionId: input.sessionId, verifyMachineAdmissionCurrent, signal: input.signal });
    return prepared?.admitted ?? null;
  } catch (error) { rethrowRequesterHomeReadFailure(error); return null; }
}

export async function isAdmittedRequesterSessionBootstrapCurrent(context: Pick<RpcHandlerContext,
  'requesterSessionBootstrap' | 'machineAdmission'> & Readonly<{ signal?: AbortSignal }> | undefined): Promise<boolean> {
  const bootstrap = context?.requesterSessionBootstrap;
  const admission = context?.machineAdmission;
  if (!bootstrap || context?.signal?.aborted
    || admission && (bootstrap.attribution.accountId !== admission.actorAccountId
      || bootstrap.attribution.machineId !== admission.machineId
      || bootstrap.attribution.installationId !== admission.installationId)) return false;
  try { return await bootstrap.isCurrent() && !context.signal?.aborted; }
  catch { return false; }
}

async function readBoundCustody(path: string, expected: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution' | 'scope' | 'endpointRole'>) {
  const value = CustodyStoredReadSchema.parse(JSON.parse(await readPrivateOwnerFile(path)) as unknown);
  if (value.scope !== expected.scope || value.endpointRole !== expected.endpointRole
    || value.sessionId !== expected.sessionId || !isDeepStrictEqual(value.attribution, expected.attribution)) return null;
  const credentials = decodeStoredCredentials(value.credentials);
  return credentials ? { credentials, homeServerIdentityId: value.homeServerIdentityId, executionIdentity: value.executionIdentity } : null;
}

/** Constrain an independently authenticated Account/Session source. Only ENOENT
 * is absence; retained birth must agree with that exact original source. A
 * different bearer needs successful canonical recovery, never this fallback. */
export async function readRequesterSessionExecutionCustodyForHost(input: RequesterSessionCredentialBinding & Readonly<{
  credentials: StoredCredentials;
  homeServerIdentityId: string;
}>): Promise<'absent' | 'retained' | 'unavailable'> {
  try {
    const stored = await readBoundCustody(requesterSessionCredentialPath(input), input);
    return stored?.homeServerIdentityId === input.homeServerIdentityId
      && sameStoredCredentials(stored.credentials, input.credentials) ? 'retained' : 'unavailable';
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? 'absent' : 'unavailable';
  }
}

export type RequesterSessionCredentialBindingsResult =
  | Readonly<{ status: 'ready'; bindings: readonly Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution' | 'scope' | 'endpointRole'>[] }>
  | Readonly<{ status: 'unavailable'; reason: 'requester_session_custody_unavailable' }>;

/** Discovers existing private custody references only; current Home admission still gates every recovery. */
export async function listRequesterSessionCredentialBindings(input: Readonly<{
  happyHomeDir: string;
  serverId: string;
  machineId: string;
  installationId: string;
  sessionId?: string;
  scope?: RequesterSessionCredentialBinding['scope'];
  endpointRole?: RequesterSessionCredentialBinding['endpointRole'];
}>): Promise<RequesterSessionCredentialBindingsResult> {
  const directory = requesterSessionCredentialDirectory({ ...input, attribution: { serverId: input.serverId } });
  let names: readonly string[];
  try {
    names = input.sessionId === undefined ? await listProtectedLocalStateDirectory(directory)
      : [basename(requesterSessionCredentialPath({ ...input, sessionId: input.sessionId, attribution: { serverId: input.serverId } }))];
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { status: 'ready', bindings: [] };
    return { status: 'unavailable', reason: 'requester_session_custody_unavailable' };
  }
  try {
    const bindings: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution' | 'scope' | 'endpointRole'>[] = [];
    for (const name of names) {
      if (!name.startsWith(requesterSessionCredentialFilePrefix(input))) continue;
      const path = join(directory, name);
      let contents: string;
      try { contents = await readPrivateOwnerFile(path); }
      catch (error) {
        if (input.sessionId !== undefined && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return { status: 'ready', bindings: [] };
        }
        throw error;
      }
      const value = CustodyStoredReadSchema.parse(JSON.parse(contents) as unknown);
      if (value.attribution.serverId !== input.serverId
        || path !== requesterSessionCredentialPath({ happyHomeDir: input.happyHomeDir,
          sessionId: value.sessionId, attribution: value.attribution, scope: value.scope, endpointRole: value.endpointRole }) || value.scope !== input.scope
        || !decodeStoredCredentials(value.credentials)) {
        return { status: 'unavailable', reason: 'requester_session_custody_unavailable' };
      }
      if (value.endpointRole !== input.endpointRole) continue;
      if (value.attribution.machineId === input.machineId && value.attribution.installationId === input.installationId) {
        bindings.push({ sessionId: value.sessionId, attribution: value.attribution, ...(value.scope ? { scope: value.scope } : {}),
          ...(value.endpointRole ? { endpointRole: value.endpointRole } : {}) });
      }
    }
    return { status: 'ready', bindings };
  } catch { return { status: 'unavailable', reason: 'requester_session_custody_unavailable' }; }
}

/** The ordinary bearer is proven by the existing authenticated Home owners, not a decoded JWT or body Account id. */
export async function verifyRequesterSessionCredentialBinding(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  attribution: RequesterWorkAttributionV1;
  scope?: RequesterSessionCredentialBinding['scope'];
  serverHttpBaseUrl: string;
  verifyMachineAdmissionCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
  expectedSessionCreationTag?: string;
  onSessionReadRefused?: () => void;
}>, caller: 'direct_binding'
  | 'custody_after_machine_binding' | 'custody_recovery' = 'direct_binding'): Promise<boolean> {
  return await readRequesterSessionCredentialBinding(input, undefined, caller) === true;
}

async function readRequesterSessionCredentialBinding(
  input: Parameters<typeof verifyRequesterSessionCredentialBinding>[0],
  readMachineAdmissionCurrent?: (signal?: AbortSignal) => ReturnType<typeof readRequesterSessionMachineAdmissionCurrent>,
  caller: 'direct_binding' | 'custody_after_machine_binding' | 'custody_recovery' = 'direct_binding',
): Promise<true | null | undefined> {
  // Opaque false can be a withdrawn local Home or an unbound Session. Only the
  // canonical Machine reader can identify its existing null refusal result.
  const readMachineCurrent = async (signal?: AbortSignal) => readMachineAdmissionCurrent
    ? await readMachineAdmissionCurrent(signal)
    : await input.verifyMachineAdmissionCurrent(signal) ? true : undefined;
  return await timeWebLatencyPhase('requester.credential_binding', async (): Promise<true | null | undefined> => {
    let sessionReadRefused = false;
    const observe = async <T>(phase: 'machine_before' | 'profile' | 'encryption' | 'session' | 'machine_after', work: () => Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      let status: 'completed' | 'failed' = 'failed';
      let diagnostic: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1> | undefined;
      try { const result = await timeWebLatencyPhase(`requester.${phase}`, work); status = 'completed'; return result; }
      catch (error) {
        diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
        if (phase === 'session' && ['session_detail_invalid_response', 'session_detail_projection_unavailable',
          'not_authenticated', 'client-upgrade-required'].includes(diagnostic.errorCode ?? '')) sessionReadRefused = true;
        throw error;
      }
      finally { logger.debug('[PluginExec] Requester currentness phase', {
        phase, status, sessionId: input.sessionId, durationMs: Math.round(performance.now() - startedAt),
        ...diagnostic,
      }); }
    };
    const discovery: RequesterBindingDiscovery = { active: true, binding: input };
    return await requesterBindingDiscovery.run(discovery, async () => {
      try {
        if (input.signal?.aborted) return undefined;
        const before = await observe('machine_before', () => readMachineCurrent(input.signal));
        if (before == null) return before;
        const [profile, currentness, session] = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => Promise.all([
          observe('profile', () => discovery.context ? Promise.resolve({ id: discovery.context.actorAccountId })
            : fetchAccountProfile({ token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) })),
          observe('encryption', () => readRequesterAccountEncryptionCurrentness({ accountId: input.attribution.accountId,
            token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl,
            ...(input.signal ? { signal: input.signal } : {}) })),
          input.scope ? Promise.resolve(null)
            : observe('session', () => fetchSessionById({ reason: 'requester-binding', token: input.credentials.token, serverUrl: input.serverHttpBaseUrl, sessionId: input.sessionId,
              ...(input.signal ? { signal: input.signal } : {}) })),
        ]));
        const owner = input.expectedSessionCreationTag !== undefined && session ? tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
          accountEncryptionMode: currentness.mode, rawSession: session }) : null;
        const correspondence = input.expectedSessionCreationTag === undefined ? null
          : SessionCreationCorrespondenceV1Schema.safeParse(owner?.sessionCreationCorrespondenceV1);
        const bound = profile.id === input.attribution.accountId
          && (input.scope !== undefined || session?.id === input.sessionId && readSessionAccessProjectionRoleV1(session) === 'owner')
          && (currentness.mode === 'plain' ? input.credentials.encryption === null : input.credentials.encryption !== null)
          && (input.expectedSessionCreationTag === undefined
            || correspondence?.success === true && correspondence.data.sessionCreationTag === input.expectedSessionCreationTag
              && correspondence.data.recipe.execution.machineId === input.attribution.machineId);
        const after = bound
          ? await observe('machine_after', () => readMachineCurrent(input.signal)) : null;
        if (input.signal?.aborted || !isRequesterAccountEncryptionCurrentnessObserved({ accountId: input.attribution.accountId,
          token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl }, currentness)) return undefined;
        return after == null ? after : true;
      } catch (error) {
        rethrowRequesterHomeReadFailure(error);
        // Preserve the existing Workspace recovery error contract.
        if (caller === 'custody_recovery' && input.scope === 'workspace_sync_relationship'
          && classifyServerEndpointError(error).kind !== 'auth_failed') throw error;
        if (sessionReadRefused && !input.signal?.aborted) input.onSessionReadRefused?.();
        if (input.signal?.aborted) return undefined;
        return classifyServerEndpointError(error).kind === 'auth_failed' ? null : undefined;
      }
      finally { discovery.active = false; discovery.context = undefined; }
    });
  });
}

export async function createRequesterSessionCredentialCustody(input: RequesterSessionCredentialBinding & Readonly<{
  credentials: StoredCredentials;
  homeServerIdentityId?: string;
  automationId?: string;
  machineAdmission?: Readonly<{ custodianAccountId: string; role?: 'use' | 'manage' }>;
  executionIdentity?: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
}>): Promise<Readonly<{ path: string; created: boolean; cleanup(): Promise<void> }>> {
  const path = requesterSessionCredentialPath(input);
  const contents = JSON.stringify(CustodySchema.parse({ v: 1, sessionId: input.sessionId,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.endpointRole ? { endpointRole: input.endpointRole } : {}),
    ...(input.executionIdentity ? { executionIdentity: input.executionIdentity } : {}),
    ...(input.automationId ? { automationId: input.automationId } : {}),
    attribution: input.attribution, credentials: encodeStoredCredentials(input.credentials),
    ...(input.homeServerIdentityId ? { homeServerIdentityId: input.homeServerIdentityId } : {}),
    ...(input.machineAdmission ? { machineAdmission: { custodianAccountId: input.machineAdmission.custodianAccountId,
      ...(input.machineAdmission.role ? { role: input.machineAdmission.role } : {}) } } : {}) }));
  let created = true;
  try { await writePrivateOwnerFile({ path, contents }); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    // Rejoin may refresh this exact requester's sign-in; never adopt a file
    // from a different Account, Home, Machine, or installation.
    const existing = await readBoundCustody(path, input);
    if (!existing || existing.homeServerIdentityId !== input.homeServerIdentityId
      || !isDeepStrictEqual(existing.executionIdentity, input.executionIdentity)) throw new Error('requester_session_custody_mismatch');
    created = false;
    await replacePrivateBearerFile({ path, contents });
  }
  return { path, created, cleanup: async () => { if (created) await removePrivateBearerFile(path); } };
}

/** Called by the existing Session retirement owner only after exact runner stop settles. */
export async function retireRequesterSessionCredentialCustody(input: RequesterSessionCredentialBinding): Promise<boolean> {
  const path = requesterSessionCredentialPath(input);
  try {
    if (!await readBoundCustody(path, input)) return false;
    await removePrivateBearerFile(path);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
  }
}

/** Rejoin/recovery consumes existing custody only after the current C41 owner permits it. */
export async function resolveRequesterSessionCredentials(input: RequesterSessionCredentialBinding & Readonly<{
  serverHttpBaseUrl: string;
  verifyMachineAdmissionCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
  onSessionReadRefused?: () => void;
}>): Promise<StoredCredentials | null> {
  return (await resolveRequesterSessionCustody(input))?.credentials ?? null;
}

type RequesterCustodyRecoveryCurrentness =
  | Readonly<{ verifyMachineAdmissionCurrent(signal?: AbortSignal): Promise<boolean>; machineAdmissionBoundary?: never }>
  | Readonly<{ machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary; verifyMachineAdmissionCurrent?: never }>;

async function resolveRequesterSessionCustody(input: Omit<Parameters<typeof resolveRequesterSessionCredentials>[0], 'verifyMachineAdmissionCurrent'>
  & RequesterCustodyRecoveryCurrentness,
  readMachineAdmissionCurrent?: (signal?: AbortSignal) => ReturnType<typeof readRequesterSessionMachineAdmissionCurrent>,
) {
  try {
    if (input.signal?.aborted) return null;
    // Sync currentness belongs to the authenticated Machine reader. A caller
    // closure could accidentally substitute a Session proof or stale admission.
    if (input.scope === 'workspace_sync_relationship' && !input.machineAdmissionBoundary) return null;
    // An opaque callback never supplies a reason to delete protected custody.
    if (input.scope !== 'workspace_sync_relationship' && !readMachineAdmissionCurrent
      && input.verifyMachineAdmissionCurrent && !await input.verifyMachineAdmissionCurrent(input.signal)) return null;
    const stored = await readBoundCustody(requesterSessionCredentialPath(input), input);
    if (!stored) return null;
    const boundary = input.machineAdmissionBoundary;
    if (boundary && stored.homeServerIdentityId && boundary.getObservedServerIdentityId
      && stored.homeServerIdentityId !== await boundary.getObservedServerIdentityId()) return null;
    const callerVerifier = input.scope === 'workspace_sync_relationship' ? undefined : input.verifyMachineAdmissionCurrent;
    const verifyMachineAdmissionCurrent = callerVerifier ?? ((signal?: AbortSignal) =>
      (input.endpointRole === 'source' ? verifyWorkspaceSyncSourceMachineAdmissionCurrent
        : input.scope === 'workspace_sync_relationship' ? verifyWorkspaceSyncRelationshipMachineAdmissionCurrent
          : verifyRequesterSessionMachineAdmissionCurrent)({
        credentials: stored.credentials, sessionId: input.sessionId, attribution: input.attribution,
        serverHttpBaseUrl: input.serverHttpBaseUrl, boundary: boundary!, signal }));
    const current = await readRequesterSessionCredentialBinding({ ...input, credentials: stored.credentials,
      verifyMachineAdmissionCurrent }, readMachineAdmissionCurrent, 'custody_recovery');
    if (current === true) return stored;
    // readBoundCustody above has already matched the exact persisted scope,
    // Account, Session/trigger id and installation attribution. Workspace keeps
    // its existing authenticated Machine recovery behavior.
    if (!input.signal?.aborted && (input.scope === 'workspace_sync_relationship'
      || input.scope === 'workflow_trigger' && current === null)) await retireRequesterSessionCredentialCustody(input);
    return null;
  } catch (error) { rethrowRequesterHomeReadFailure(error); return null; }
}

/** The existing custody id slot holds the relationship id, never a fictional Session. */
export type WorkspaceSyncRelationshipCredentialBinding = Omit<RequesterSessionCredentialBinding, 'sessionId' | 'scope' | 'endpointRole'>
  & Readonly<{ relationshipId: string }>;

/** Open captures the admitted requester once; recovery reuses this exact identity. */
export async function createWorkspaceSyncRelationshipCredentialCustody(input: WorkspaceSyncRelationshipCredentialBinding
  & Omit<Parameters<typeof createRequesterSessionCredentialCustody>[0], keyof RequesterSessionCredentialBinding | 'executionIdentity' | 'automationId'>
  & Readonly<{ executionIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }> }>
): ReturnType<typeof createRequesterSessionCredentialCustody> {
  return await createRequesterSessionCredentialCustody({ ...input, sessionId: input.relationshipId,
    scope: 'workspace_sync_relationship' });
}

/** The relationship owner validates its graph; this owner verifies Account and Machine on reconnect. */
export async function resolveWorkspaceSyncRelationshipCredentialCustody(input: WorkspaceSyncRelationshipCredentialBinding
  & Omit<Parameters<typeof resolveRequesterSessionCredentials>[0], keyof RequesterSessionCredentialBinding | 'onSessionReadRefused' | 'verifyMachineAdmissionCurrent'>
  & Readonly<{ machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary }>
): Promise<Readonly<{ credentials: StoredCredentials;
  executionIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }> }> | null> {
  const stored = await resolveRequesterSessionCustody({ ...input, sessionId: input.relationshipId,
    scope: 'workspace_sync_relationship' });
  return stored?.executionIdentity ? { credentials: stored.credentials, executionIdentity: stored.executionIdentity } : null;
}

/** SOURCE retains its actual requester Account admission; it has no target native identity. */
export async function createWorkspaceSyncSourceCredentialCustody(input: WorkspaceSyncRelationshipCredentialBinding
  & Omit<Parameters<typeof createRequesterSessionCredentialCustody>[0], keyof RequesterSessionCredentialBinding | 'executionIdentity' | 'automationId'>
): ReturnType<typeof createRequesterSessionCredentialCustody> {
  return await createRequesterSessionCredentialCustody({ ...input, sessionId: input.relationshipId,
    scope: 'workspace_sync_relationship', endpointRole: 'source' });
}

export async function resolveWorkspaceSyncSourceCredentialCustody(input: WorkspaceSyncRelationshipCredentialBinding
  & Omit<Parameters<typeof resolveRequesterSessionCredentials>[0], keyof RequesterSessionCredentialBinding | 'onSessionReadRefused' | 'verifyMachineAdmissionCurrent'>
  & Readonly<{ machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary }>
): Promise<StoredCredentials | null> {
  return (await resolveRequesterSessionCustody({ ...input, sessionId: input.relationshipId,
    scope: 'workspace_sync_relationship', endpointRole: 'source' }))?.credentials ?? null;
}

export async function bindRequesterSessionMachineControl(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  attribution: RequesterWorkAttributionV1;
  serverHttpBaseUrl: string;
}>): Promise<void> {
  await ensureSessionMachineAccessKeyBinding({ serverUrl: input.serverHttpBaseUrl,
    token: input.credentials.token, sessionId: input.sessionId, machineId: input.attribution.machineId });
}

export { rethrowRequesterHomeReadFailure } from '@/daemon/sessionEncryption/requesterCurrentness';
export { runWithRequesterSessionCurrentnessCheckpoint } from '@/daemon/sessionEncryption/requesterCurrentness';
export { runWithoutRequesterSessionCurrentnessCheckpoint } from '@/daemon/sessionEncryption/requesterCurrentness';
