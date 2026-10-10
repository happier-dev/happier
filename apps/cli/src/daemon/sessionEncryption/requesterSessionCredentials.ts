import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionRequesterBootstrapCredentialsV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { SessionRequesterBootstrapV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { configuration } from '@/configuration';
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { fetchAccountProfile } from '@/api/accountProfile';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readPrivateOwnerFile, writePrivateOwnerFile, replacePrivateBearerFile, removePrivateBearerFile } from '../privateBearerFile';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { ApiClient } from '@/api/api';
import type { ExecuteSpawnSessionRequestParams } from '../startup/executeSpawnSessionRequest';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ConnectedServiceQualifiedAuthGroupApi } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type { RequesterAccountActionAuthorizationInput } from './requesterAccountActionProjection';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { listProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';

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

/** Exact live Session Account ports; owned by ordinary daemon Session lifecycle, never serialized. */
export type RequesterSessionRuntimeContext = Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
  /** Includes admission, saved-secret custody and this runtime's retirement. */
  isCurrent(): Promise<boolean>;
  api: ApiClient;
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
  refreshAccountSettings(minSettingsVersion?: number): Promise<boolean>;
  activeServerDir: string;
  connectedServicesMaterializationBaseDir: string;
  connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  providerAccountUsagePersistence: ProviderAccountUsagePersistenceScheduler;
  dispose(): Promise<void>;
}> & Pick<ExecuteSpawnSessionRequestParams,
  'connectedServiceRefreshCoordinator' | 'connectedServiceQuotasCoordinator'
  | 'connectedServiceRuntimeRegistry' | 'providerAccountUsageStore'
  | 'authGroupSwitchCoordinator' | 'predictiveSwitchGuard' | 'resolveManagedPurposeBindingIntent'
  | 'activateSessionPurposeBindings' | 'activatePurposeBindings'>;

export type ResolveRequesterSessionRuntimeContext = (
  sessionId: string, attribution?: RequesterWorkAttributionV1,
) => Promise<RequesterSessionRuntimeContext | null>;

/** Canonical Session Account assertion used by the daemon's captured operation context. */
export async function assertRequesterSessionAccountContextCurrent(input: Readonly<{
  expected: RequesterSessionRuntimeContext | null;
  resolveCurrent(): Promise<RequesterSessionRuntimeContext | null>;
  readTrackedContext(): RequesterSessionRuntimeContext | null;
}>): Promise<void> {
  if (input.expected) {
    const tracked = input.readTrackedContext();
    if (tracked && tracked !== input.expected || !await input.expected.isCurrent()) {
      throw new Error('requester_session_not_current');
    }
    return;
  }
  const current = await input.resolveCurrent();
  if (!current) return;
  if (input.readTrackedContext() !== current) await current.dispose();
  throw new Error('requester_session_not_current');
}

export const REQUESTER_SESSION_CREDENTIAL_FILE_ENV = 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE';
export const REQUESTER_SESSION_ID_ENV = 'HAPPIER_SESSION_REQUESTER_SESSION_ID';

/** Created by the receiving host after admission; never accepted from decrypted caller input. */
export type AdmittedRequesterSessionBootstrap = Readonly<{
  credentials: StoredCredentials;
  preparedSessionId?: string;
  attribution: RequesterWorkAttributionV1;
  serverHttpBaseUrl: string;
  accountSettingsContext: AccountSettingsContext;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  isCurrent(): Promise<boolean>;
  getBoundSessionId(): string | null;
  /** Installed by the ordinary daemon runtime owner, never by transported caller input. */
  bindRuntimeMachineAdmissionCurrentness(verify: () => Promise<boolean>): void;
  projectExternalActionAuthorization(authorization: ExternalActionExecutionAuthorizationV1,
    observedServerIdentityId: string, signal?: AbortSignal): Promise<ExternalActionExecutionAuthorizationV1 | null>;
  bindSession(sessionId: string, sessionCreationTag: string): Promise<Readonly<{ path: string; cleanup(): Promise<void> }> | null>;
  /** Existing-Session adoption retains the original immutable creation recipe. */
  bindExistingSession(sessionId: string): Promise<Readonly<{ path: string; cleanup(): Promise<void> }> | null>;
}>;

export async function admitRequesterSessionBootstrap(input: Readonly<{
  bootstrap: SessionRequesterBootstrapV1;
  boundary: Readonly<{ serverId: string; serverHttpBaseUrl: string; happyHomeDir: string }>;
  context: RpcHandlerContext;
  /** Existing ordinary Session received by the host handoff ingress, never a creation recipe rewrite. */
  existingSessionId?: string;
}>): Promise<Readonly<{ admitted: AdmittedRequesterSessionBootstrap; cleanupOnFailure(): Promise<void> }> | null> {
  const admission = input.context.machineAdmission;
  const verify = input.context.verifyMachineAdmissionCurrent;
  const credentials = decodeStoredCredentials(input.bootstrap.credentials);
  if (!admission || !verify || !credentials || input.context.signal.aborted) return null;
  const attribution = RequesterWorkAttributionV1Schema.parse({ serverId: input.boundary.serverId,
    accountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId });
  const preparedSessionId = 'sessionId' in input.bootstrap ? input.bootstrap.sessionId : undefined;
  return await prepareRequesterSessionBootstrap({ credentials, attribution, boundary: input.boundary,
    verifyMachineAdmissionCurrent: verify, signal: input.context.signal,
    ...(input.existingSessionId ? { preparedSessionId: input.existingSessionId, boundSessionId: input.existingSessionId } : {}),
    ...(preparedSessionId ? { preparedSessionId } : {}) });
}

export async function prepareRequesterSessionBootstrap(input: Readonly<{
  credentials: StoredCredentials;
  attribution: RequesterWorkAttributionV1;
  boundary: Readonly<{ serverId: string; serverHttpBaseUrl: string; happyHomeDir: string }>;
  verifyMachineAdmissionCurrent(): Promise<boolean>;
  signal?: AbortSignal;
  preparedSessionId?: string;
  boundSessionId?: string;
}>): Promise<Readonly<{ admitted: AdmittedRequesterSessionBootstrap; cleanupOnFailure(): Promise<void> }> | null> {
  const { credentials, attribution, preparedSessionId } = input;
  const verify = input.verifyMachineAdmissionCurrent;
  let bound: Readonly<{ sessionId: string; sessionCreationTag?: string }> | null = input.boundSessionId
    ? { sessionId: input.boundSessionId } : null;
  let verifyRuntime = input.boundSessionId ? verify : null;
  const readAccountCurrentness = async () => await runWithServerHttpBaseUrl(input.boundary.serverHttpBaseUrl, async () => {
    if (input.signal?.aborted || !await verify()) return null;
    const [profile, currentness] = await Promise.all([
      fetchAccountProfile({ token: credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
      fetchAccountEncryptionCurrentness({ token: credentials.token, serverBaseUrl: input.boundary.serverHttpBaseUrl,
        ...(input.signal ? { signal: input.signal } : {}) }),
    ]);
    return profile.id === attribution.accountId
      && (currentness.mode === 'plain' ? credentials.encryption === null : credentials.encryption !== null)
      && !input.signal?.aborted && await verify() ? currentness : null;
  });
  const currentness = await readAccountCurrentness();
  if (!currentness) return null;
  bindRequesterSessionCredentialScope(credentials, { serverId: attribution.serverId,
    serverHttpBaseUrl: normalizeServerHttpBaseUrl(input.boundary.serverHttpBaseUrl) });
  let cleanup: () => Promise<void> = async () => undefined;
  const isCurrent = async () => bound
    ? verifyRuntime !== null && await verifyRequesterSessionCredentialBinding({ credentials, ...bound, attribution,
      ...(bound.sessionCreationTag ? { expectedSessionCreationTag: bound.sessionCreationTag } : {}),
      serverHttpBaseUrl: input.boundary.serverHttpBaseUrl,
      verifyMachineAdmissionCurrent: verifyRuntime })
    : await readAccountCurrentness() !== null;
  if (!await isCurrent()) return null;
  const accountSettingsContext = await runWithServerHttpBaseUrl(input.boundary.serverHttpBaseUrl,
    () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
      honorAccountSettingsModeEnv: false, minSettingsVersion: currentness.settingsVersion,
      shouldCommit: () => !input.signal?.aborted }));
  if (accountSettingsContext.source !== 'network' || !await isCurrent()) return null;
  const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials,
    snapshot: accountSettingsContext, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl, isCurrent });
  const persistVerifiedCustody = async (binding: Parameters<typeof verifyRequesterSessionCredentialBinding>[0]) => {
    if (!await verifyRequesterSessionCredentialBinding(binding)) return null;
    await bindRequesterSessionMachineControl(binding);
    if (!await verifyRequesterSessionCredentialBinding(binding)) return null;
    return await createRequesterSessionCredentialCustody({ ...binding, happyHomeDir: input.boundary.happyHomeDir });
  };
  const bindSession: AdmittedRequesterSessionBootstrap['bindSession'] = async (sessionId, sessionCreationTag) => {
    if (!verifyRuntime || preparedSessionId && preparedSessionId !== sessionId || bound && (bound.sessionId !== sessionId
      || bound.sessionCreationTag !== undefined && bound.sessionCreationTag !== sessionCreationTag) || !await isCurrent()) return null;
    const binding = { credentials, sessionId, attribution, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl,
      verifyMachineAdmissionCurrent: bound ? verifyRuntime : verify,
      ...(!bound && input.signal ? { signal: input.signal } : {}), expectedSessionCreationTag: sessionCreationTag };
    const custody = await persistVerifiedCustody(binding);
    if (!custody) return null;
    bound = { sessionId, sessionCreationTag };
    cleanup = custody.cleanup;
    if (!await isCurrent()) { await cleanup(); return null; }
    return { path: custody.path, cleanup };
  };
  const bindExistingSession: AdmittedRequesterSessionBootstrap['bindExistingSession'] = async sessionId => {
    if (!bound || bound.sessionId !== sessionId || !verifyRuntime || !await isCurrent()) return null;
    const binding = { credentials, sessionId, attribution, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl,
      verifyMachineAdmissionCurrent: verifyRuntime };
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
  return { admitted: Object.freeze({ credentials, ...(preparedSessionId ? { preparedSessionId } : {}),
    attribution, serverHttpBaseUrl: input.boundary.serverHttpBaseUrl, accountSettingsContext,
    savedSecretOperationContext, isCurrent, getBoundSessionId: () => bound?.sessionId ?? null, bindSession, bindExistingSession,
    bindRuntimeMachineAdmissionCurrentness: (current: () => Promise<boolean>) => { verifyRuntime = current; },
    projectExternalActionAuthorization,
  }),
    cleanupOnFailure: async () => {
      savedSecretOperationContext.withdrawCatalog();
      await cleanup();
    } };
}

/** Daemon credentials sign installation proofs only; requester content always uses the protected requester bearer. */
export type RequesterSessionMachineAdmissionBoundary = Readonly<{
  machineId: string;
  daemonToken: string;
  isHomeCurrent(): boolean;
  readInstallation(): Readonly<{ installationId: string; privateKey: string | Uint8Array }> | null;
}>;

/** Runtime authority follows custody binding, not a prepared Session id or the completed launch RPC. */
export function bindRequesterSessionRuntimeMachineAdmissionCurrentness(input: Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
  boundary: RequesterSessionMachineAdmissionBoundary;
}>): void {
  const { bootstrap, boundary } = input;
  bootstrap.bindRuntimeMachineAdmissionCurrentness(async () => {
    const sessionId = bootstrap.getBoundSessionId();
    if (sessionId === null) return false;
    return await verifyRequesterSessionMachineAdmissionCurrent({
      credentials: bootstrap.credentials, attribution: bootstrap.attribution, sessionId,
      serverHttpBaseUrl: bootstrap.serverHttpBaseUrl, boundary,
    });
  });
}

/** Fresh facts come from the existing authenticated access reader and C41 verifier, not a retained RPC envelope. */
export async function verifyRequesterSessionMachineAdmissionCurrent(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  attribution: RequesterWorkAttributionV1;
  serverHttpBaseUrl: string;
  boundary: RequesterSessionMachineAdmissionBoundary;
}>): Promise<boolean> {
  try {
    const installation = input.boundary.readInstallation();
    if (!input.boundary.isHomeCurrent() || input.attribution.machineId !== input.boundary.machineId
      || installation?.installationId !== input.attribution.installationId) return false;
    const readAccess = createAccountServerActionDeps({ token: input.credentials.token,
      serverId: input.attribution.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl }).machineAccessAction;
    if (!readAccess) return false;
    const [profile, result] = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => Promise.all([
      fetchAccountProfile({ token: input.credentials.token }),
      readAccess({ actionId: 'machines.access.grants.list', input: { serverId: input.attribution.serverId,
        machineId: input.attribution.machineId }, context: { surface: 'cli', serverId: input.attribution.serverId } }),
    ]));
    const access = MachineAccessGrantsListResponseV1Schema.safeParse(result);
    if (profile.id !== input.attribution.accountId || !access.success
      || access.data.machineId !== input.attribution.machineId || access.data.access.accessState !== 'ready'
      || access.data.custodian.accountId !== access.data.access.custodian.accountId
      || !input.boundary.isHomeCurrent()
      || input.boundary.readInstallation()?.installationId !== installation.installationId) return false;
    const current = await verifyMachineRpcAdmissionCurrent({ context: { actorAccountId: profile.id,
      custodianAccountId: access.data.custodian.accountId, machineId: input.attribution.machineId,
      installationId: installation.installationId, role: access.data.access.role,
      encryptionMode: access.data.access.resourceMode }, purpose: { kind: 'requester_session_currentness', sessionId: input.sessionId },
      privateKey: installation.privateKey, daemonToken: input.boundary.daemonToken, serverHttpBaseUrl: input.serverHttpBaseUrl });
    return current && input.boundary.isHomeCurrent()
      && input.boundary.readInstallation()?.installationId === installation.installationId;
  } catch { return false; }
}

/** Reconstructs Account ports for this exact Session; protected custody is data, never an authority witness. */
export async function resolveRequesterSessionBootstrap(input: RequesterSessionCredentialBinding & Readonly<{
  serverHttpBaseUrl: string;
  machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary;
}>): Promise<AdmittedRequesterSessionBootstrap | null> {
  try {
    const stored = await readBoundCustody(requesterSessionCredentialPath(input), input);
    if (!stored) return null;
    const verify = (credentials: StoredCredentials) => async () => await verifyRequesterSessionMachineAdmissionCurrent({
      credentials, sessionId: input.sessionId, attribution: input.attribution, serverHttpBaseUrl: input.serverHttpBaseUrl,
      boundary: input.machineAdmissionBoundary });
    const credentials = await resolveRequesterSessionCredentials({ ...input, verifyMachineAdmissionCurrent: verify(stored) });
    if (!credentials) return null;
    const result = await prepareRequesterSessionBootstrap({ credentials, attribution: input.attribution,
      boundary: { serverId: input.attribution.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl, happyHomeDir: input.happyHomeDir },
      preparedSessionId: input.sessionId, boundSessionId: input.sessionId, verifyMachineAdmissionCurrent: verify(credentials) });
    return result?.admitted ?? null;
  } catch { return null; }
}

/** Cold handoff recovery selects only an existing exact local Session reference. */
export async function resolveRequesterSessionBootstrapFromCustody(input: Readonly<{
  happyHomeDir: string; serverId: string; sessionId: string; serverHttpBaseUrl: string;
  machineAdmissionBoundary: RequesterSessionMachineAdmissionBoundary;
}>): Promise<AdmittedRequesterSessionBootstrap | null> {
  const boundary = input.machineAdmissionBoundary;
  const installation = boundary.readInstallation();
  if (!installation || !boundary.isHomeCurrent()) return null;
  const existing = await listRequesterSessionCredentialBindings({ happyHomeDir: input.happyHomeDir,
    serverId: input.serverId, machineId: boundary.machineId, installationId: installation.installationId });
  if (existing.status !== 'ready' || !boundary.isHomeCurrent()
    || boundary.readInstallation()?.installationId !== installation.installationId) return null;
  const binding = existing.bindings.find(candidate => candidate.sessionId === input.sessionId);
  return binding ? await resolveRequesterSessionBootstrap({ ...input, attribution: binding.attribution }) : null;
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

const CustodySchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  attribution: RequesterWorkAttributionV1Schema,
  credentials: SessionRequesterBootstrapCredentialsV1Schema,
}).strict();
const CustodyStoredReadSchema = createStoredReadSchema(CustodySchema);

export type RequesterSessionCredentialBinding = Readonly<{
  happyHomeDir: string;
  sessionId: string;
  attribution: RequesterWorkAttributionV1;
}>;

/** Local private state, not a Session lifecycle ledger or an authority witness. */
export function requesterSessionCredentialPath(binding: RequesterSessionCredentialBinding): string {
  return join(binding.happyHomeDir, 'requester-session-credentials',
    `home-${encodeURIComponent(binding.attribution.serverId)}`,
    `session-${encodeURIComponent(binding.sessionId)}.json`);
}

async function readBoundCustody(path: string, expected: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution'>) {
  const value = CustodyStoredReadSchema.parse(JSON.parse(await readPrivateOwnerFile(path)) as unknown);
  if (value.sessionId !== expected.sessionId || !isDeepStrictEqual(value.attribution, expected.attribution)) return null;
  return decodeStoredCredentials(value.credentials);
}

export type RequesterSessionCredentialBindingsResult =
  | Readonly<{ status: 'ready'; bindings: readonly Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution'>[] }>
  | Readonly<{ status: 'unavailable'; reason: 'requester_session_custody_unavailable' }>;

/** Discovers existing private custody references only; current Home admission still gates every recovery. */
export async function listRequesterSessionCredentialBindings(input: Readonly<{
  happyHomeDir: string;
  serverId: string;
  machineId: string;
  installationId: string;
}>): Promise<RequesterSessionCredentialBindingsResult> {
  const directory = join(input.happyHomeDir, 'requester-session-credentials', `home-${encodeURIComponent(input.serverId)}`);
  let names: readonly string[];
  try { names = await listProtectedLocalStateDirectory(directory); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { status: 'ready', bindings: [] };
    return { status: 'unavailable', reason: 'requester_session_custody_unavailable' };
  }
  try {
    const bindings: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution'>[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const value = CustodyStoredReadSchema.parse(JSON.parse(await readPrivateOwnerFile(path)) as unknown);
      if (value.attribution.serverId !== input.serverId
        || path !== requesterSessionCredentialPath({ happyHomeDir: input.happyHomeDir,
          sessionId: value.sessionId, attribution: value.attribution }) || !decodeStoredCredentials(value.credentials)) {
        return { status: 'unavailable', reason: 'requester_session_custody_unavailable' };
      }
      if (value.attribution.machineId === input.machineId && value.attribution.installationId === input.installationId) {
        bindings.push({ sessionId: value.sessionId, attribution: value.attribution });
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
  serverHttpBaseUrl: string;
  verifyMachineAdmissionCurrent(): Promise<boolean>;
  signal?: AbortSignal;
  expectedSessionCreationTag?: string;
}>): Promise<boolean> {
  try {
    if (input.signal?.aborted || !await input.verifyMachineAdmissionCurrent()) return false;
    const [profile, currentness, session] = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => Promise.all([
      fetchAccountProfile({ token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
      fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl,
        ...(input.signal ? { signal: input.signal } : {}) }),
      fetchSessionById({ token: input.credentials.token, serverUrl: input.serverHttpBaseUrl, sessionId: input.sessionId,
        ...(input.signal ? { signal: input.signal } : {}) }),
    ]));
    const owner = session ? tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
      accountEncryptionMode: currentness.mode, rawSession: session }) : null;
    const correspondence = input.expectedSessionCreationTag === undefined ? null
      : SessionCreationCorrespondenceV1Schema.safeParse(owner?.sessionCreationCorrespondenceV1);
    return profile.id === input.attribution.accountId
      && session?.id === input.sessionId && readSessionAccessProjectionRoleV1(session) === 'owner'
      && (currentness.mode === 'plain' ? input.credentials.encryption === null : input.credentials.encryption !== null)
      && (input.expectedSessionCreationTag === undefined
        || correspondence?.success === true && correspondence.data.sessionCreationTag === input.expectedSessionCreationTag
          && correspondence.data.recipe.execution.machineId === input.attribution.machineId)
      && !input.signal?.aborted && await input.verifyMachineAdmissionCurrent();
  } catch { return false; }
}

export async function createRequesterSessionCredentialCustody(input: RequesterSessionCredentialBinding & Readonly<{
  credentials: StoredCredentials;
}>): Promise<Readonly<{ path: string; created: boolean; cleanup(): Promise<void> }>> {
  const path = requesterSessionCredentialPath(input);
  const contents = JSON.stringify(CustodySchema.parse({ v: 1, sessionId: input.sessionId,
    attribution: input.attribution, credentials: encodeStoredCredentials(input.credentials) }));
  let created = true;
  try { await writePrivateOwnerFile({ path, contents }); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    // Rejoin may refresh this exact requester's sign-in; never adopt a file
    // from a different Account, Home, Machine, or installation.
    if (!await readBoundCustody(path, input)) throw new Error('requester_session_custody_mismatch');
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
  verifyMachineAdmissionCurrent(): Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<StoredCredentials | null> {
  try {
    if (input.signal?.aborted || !await input.verifyMachineAdmissionCurrent()) return null;
    const credentials = await readBoundCustody(requesterSessionCredentialPath(input), input);
    return credentials && await verifyRequesterSessionCredentialBinding({ ...input, credentials }) ? credentials : null;
  } catch { return null; }
}

/** Only a private path travels to the child; failure never selects a global credential. */
export async function readRequesterSessionCredentialsForChild(path: string): Promise<StoredCredentials | null> {
  try {
    if (!path || !process.env[REQUESTER_SESSION_ID_ENV]) return null;
    const value = CustodyStoredReadSchema.parse(JSON.parse(await readPrivateOwnerFile(path)) as unknown);
    if (value.sessionId !== process.env[REQUESTER_SESSION_ID_ENV]
      || value.attribution.serverId !== configuration.activeServerId) return null;
    const credentials = decodeStoredCredentials(value.credentials);
    return credentials ? bindRequesterSessionCredentialScope(credentials, { serverId: value.attribution.serverId,
      serverHttpBaseUrl: normalizeServerHttpBaseUrl(configuration.apiServerUrl),
      requesterSession: { sessionId: value.sessionId, attribution: value.attribution } }) : null;
  } catch { return null; }
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
