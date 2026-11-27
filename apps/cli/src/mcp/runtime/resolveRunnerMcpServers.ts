import { formatMcpToolWireNameV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { isPluginError, readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { McpServerConfig } from '@/agent';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import { sessionMcpAgentLaunchContextFile } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { AdmittedMcpStdioRuntime, PrepareMcpStdioTransport } from './supervisedStdioTransport';
import { SESSION_MCP_CONTEXT_FILE_ENV } from './sessionMcpLocalTransport';
import { resolveSessionAgentMcpContextFile } from '@/subprocess/supervision/sessionTargetRelay';
import { createSessionMcpCustomToolsBridge, type SessionMcpCustomToolsBridge, type SessionCustomMcpServer } from './sessionMcpToolsBridge';
import { createSessionCustomMcpClientPool } from '@/agent/tools/happierTools/customMcp/sessionCustomMcpClientPool';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { supportsSessionMcpLocalTransport } from './sessionMcpLocalContext';
import { createMcpPermissionChoices } from './mcpPermissionChoices';
import type { SessionMcpLocalContext, SessionMcpLocalTransportOptions } from './sessionMcpLocalTransport';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { ExecutionRunOccurrenceWitnessV1 } from '@/agent/runtime/bridges/executionRun/runOccurrenceWitness';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { SESSION_RUN_PROMPT_READ_ACTION_IDS_V1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { SessionCapabilityNoticeV1Schema, SESSION_CAPABILITY_NOTICE_SIDECAR_KEY, type SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import type { AccountSettings, ActionExecutorDeps, SessionRunPromptReadActionIdV1 } from '@happier-dev/protocol';
import { readLoadedMcpNativeServerNames, type McpServerIdentity } from './assignMcpWireNames';
import { detectProviderMcpServers } from '../providerDetection/detectProviderMcpServers';
import type { ResolvedSessionMcpServer } from '../runtimeTypes';
import { applyAttachedPluginMcpTransport } from './applyAttachedPluginMcpTransport';
import { projectResolvedMcpServers } from './projectResolvedMcpServers';
import { isMcpPluginItemIdV1, resolveMcpToolLoadingV1, type McpPluginItemV1, type McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { DetectedMcpServerV1 } from '@happier-dev/protocol';
import { projectMcpToolLaunchPolicies } from './projectMcpToolLaunchPolicy';
import type { PluginAgentToolsCapabilityV2 } from '@happier-dev/protocol';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings, readMcpServersSettingsForStartup } from '../servers/readMcpServersSettingsFromAccountSettings';
import { hasExplicitlyEmptyManagedMcpSelection, resolveSessionCapabilitiesForDirectory } from '../servers/resolveSessionCapabilitiesForDirectory';
import {
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';
import { listSelectedMcpSharedSecretReferences, materializeMcpServerConfigRecord } from '../servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '../servers/mergeWithBuiltInHappierMcpServer';
import {
  createSavedSecretMaterializerV1,
  SavedSecretResolutionError,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation, savedSecretOperationAdmissionStatus } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { acquireSavedSecretMaterializerForOperation, SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import type { HappyMcpSessionClient } from '../startHappyServer';
import { SessionAttestedContextV1Schema } from '@happier-dev/protocol/sessions/creation/sessionAttestedContextV1';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { AccountExecutionRuntimeRegistryLease as PluginRuntimeRegistryLease } from '@/plugins/runtime/accountExecutionRuntime';
import { randomUUID } from 'node:crypto';
import { createHappierMcpToolNamingResolver } from './projectMcpToolNames';
import { readMcpRequestAuthFailureCode, readMcpRequestAuthDiagnosticCode, readMcpRequestAuthFailureDiagnostic, type McpRequestAuthCapability, type McpRequestAuthFailureCode } from './mcpRequestAuth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { assertMcpStdioExecutionSupported, readMcpExecutionSource, type McpExecutionSource } from './mcpExecutionSource';

/**
 * The exact Session-owned Run whose authority this MCP profile serves.
 *
 * `readCurrentRunOccurrence` projects the bridge's canonical controller entry,
 * deliberately read per request: the built-in Happier server is rebuilt for each
 * MCP call, so a resumed or replaced controller occurrence must stop supplying
 * authority without rebuilding the server.
 */
export type ExecutionRunMcpBinding = Readonly<{
  actionInvocation?: import('@happier-dev/protocol/sessions/creation/externalActionRequesterInvocationBaseV1').ExternalActionRequesterInvocationBaseV1;
  runId: string;
  /** Trusted absolute depth from this Run's canonical host manager. */
  workDepth: number;
  /** The Run's working location; the parent Session remains the resource scope. */
  cwd: string;
  /** The Run runtime's own lifetime, not the parent Session's. */
  signal: AbortSignal;
  isCurrent: () => boolean;
  getPermissionMode?: NonNullable<HappyMcpSessionClient['getPermissionMode']>;
  /** This Run's own admitted turn; `null` between turns and once superseded. */
  readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
  readCurrentRunOccurrence: (runId: string) => ExecutionRunOccurrenceWitnessV1 | null;
}>;

function createRunScopedMcpSessionView(
  session: HappyMcpSessionClient,
  run: ExecutionRunMcpBinding,
): HappyMcpSessionClient {
  const readWitness = (): AgentInvocationTurnAdmissionWitness | null => {
    // Currentness is the occurrence owner's answer, never the caller's guess.
    if (!run.readCurrentRunOccurrence(run.runId)) return null;
    const witness = run.readActiveTurnAdmissionWitness();
    return witness ? { ...witness, agentStartCaller: { kind: 'session', sessionId: session.sessionId,
      starterDepth: run.workDepth, turnDepth: run.workDepth } } : null;
  };
  return {
    ...session,
    getRunActionInvocation: () => run.actionInvocation,
    // Class prototype methods are not preserved by object spread. Forward the
    // admitted Session transport's immutable Home binding explicitly so a
    // Run-scoped MCP view cannot fall back to ambient Home configuration.
    getServerBinding: () => session.getServerBinding(),
    ...(session.getCurrentSessionSkillItems
      ? { getCurrentSessionSkillItems: () => session.getCurrentSessionSkillItems!() } : {}),
    ...(session.getSessionRoleContext
      ? { getSessionRoleContext: () => session.getSessionRoleContext!() } : {}),
    ...(session.readRoleSources
      ? { readRoleSources: (...args: Parameters<NonNullable<HappyMcpSessionClient['readRoleSources']>>) => session.readRoleSources!(...args) } : {}),
    getMcpRequestAuthPort: () => session.getMcpRequestAuthPort?.(),
    getPluginMcpPort: () => session.getPluginMcpPort?.() ?? null,
    ...(session.getEphemeralStreamConnectionEpoch
      ? { getEphemeralStreamConnectionEpoch: () => session.getEphemeralStreamConnectionEpoch!() } : {}),
    ...(session.isDaemonPluginCatalogSignalReady
      ? { isDaemonPluginCatalogSignalReady: () => session.isDaemonPluginCatalogSignalReady!() } : {}),
    ...(session.subscribeDaemonPluginCatalogChanges
      ? { subscribeDaemonPluginCatalogChanges: (listener: Parameters<NonNullable<HappyMcpSessionClient['subscribeDaemonPluginCatalogChanges']>>[0]) => session.subscribeDaemonPluginCatalogChanges!(listener) } : {}),
    ...(session.getBackendTarget ? { getBackendTarget: () => session.getBackendTarget!() } : {}),
    ...(session.getMetadataSnapshot ? { getMetadataSnapshot: () => session.getMetadataSnapshot!() } : {}),
    ...(session.getMachineAdmissionTransport
      ? { getMachineAdmissionTransport: () => session.getMachineAdmissionTransport!() }
      : {}),
    ...(session.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: () => session.getServerFeaturesSnapshot!() }
      : {}),
    ...(session.getStoredContentEncryptionContext
      ? { getStoredContentEncryptionContext: () => session.getStoredContentEncryptionContext!() }
      : {}),
    getPermissionMode: () => run.getPermissionMode ? run.getPermissionMode() : session.getPermissionMode?.(),
    getWorkDepth: () => run.workDepth,
    getAgentStartRunCaller: () => run.isCurrent() && !run.signal.aborted && run.readCurrentRunOccurrence(run.runId)
      ? { hostSessionId: session.sessionId, callingRunId: run.runId, callingRunDepth: run.workDepth }
      : null,
    getActiveTurnPermissionWitness: () => {
      const witness = readWitness();
      return witness
        ? {
          turnId: witness.turnId,
          workDepth: run.workDepth,
          ...(witness.causalPermissionAuthority
            ? { causalPermissionAuthority: witness.causalPermissionAuthority }
            : {}),
        }
        : null;
    },
    getActiveTurnAdmissionWitness: readWitness,
    // This profile belongs to the Run, not its concurrently active parent turn.
    // Run cancellation already comes from its own lifetime below.
    getHostTurnAbortSignal: () => null,
    getRuntimeLifetimeSignal: () => run.signal,
    getSessionActionConfirmationBinding: () => {
      const occurrence = run.readCurrentRunOccurrence(run.runId);
      const witness = occurrence ? run.readActiveTurnAdmissionWitness() : null;
      if (!occurrence || !witness) return null;
      const { occurrenceId, sidechainId } = occurrence;
      return {
        turnId: witness.turnId,
        lifetimeSignal: run.signal,
        // A superseded occurrence, a retired turn, or a cancelled controller all
        // retire an already issued confirmation without a second decision owner.
        isCurrent: () => {
          const current = run.readCurrentRunOccurrence(run.runId);
          return current?.occurrenceId === occurrenceId
            && run.isCurrent()
            && run.readActiveTurnAdmissionWitness()?.turnId === witness.turnId;
        },
        run: { runId: run.runId, occurrenceId, sidechainId },
      };
    },
    getCurrentSessionLocation: () => ({
      ...(session.getCurrentSessionLocation?.() ?? {}),
      path: run.cwd,
    }),
  };
}

type RunnerMcpServersParams = Readonly<{
  session: HappyMcpSessionClient & Required<Pick<HappyMcpSessionClient, 'enqueueSessionEventCommitted'>>;
  credentials: StoredCredentials;
  /** Account-wide Action authority; explicit null keeps the runtime Session-scoped. */
  accountCredentials?: StoredCredentials | null;
  sessionList?: ActionExecutorDeps['sessionList'];
  accountSettings: AccountSettings | null;
  accountSettingsSnapshot?: ActiveAccountSettingsSnapshot | null;
  /** The existing invocation's Home/Account custody; never borrowed by Session authority. */
  operationContext?: SavedSecretOperationContextV1;
  /** Exact runtime policy when ambient Account settings are intentionally unavailable. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Exact caller-owned registry lease for daemonless scoped runtimes. */
  pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
  pluginMcpRuntimeRegistry?: PluginRuntimeRegistryLease['registry'];
  detectedMcpServers?: readonly DetectedMcpServerV1[];
  mcpPermissionHandler?: Pick<import('@/agent/permissions/providerEnforced/handler').ProviderEnforcedPermissionHandler, 'handleToolCall'>;
  machineId: string;
  directory: string;
  agentId?: string | null;
  agentAcceptsUserMcp?: boolean;
  mcpToolControl?: PluginAgentToolsCapabilityV2['mcpToolControl'];
  scriptRunnerEnabled?: boolean;
  unlistedTools?: import('@happier-dev/protocol/runtime/agentSessionV1').AgentSessionConfigurationSnapshotV1['unlistedTools'];
  mcpToolCallIdMetaKey?: PluginAgentToolsCapabilityV2['mcpToolCallIdMetaKey'];
  sessionMetadata?: Readonly<Record<string, unknown>> | null;
  env?: ProcessEnvInput;
  tmpDir?: string | null;
  commandMode?: NonNullable<Parameters<typeof createHappierMcpBridge>[1]>['commandMode'];
  resolvedMcpServers?: Record<string, McpServerConfig>;
  /** Extension-delivered Happier tools already have their own bridge. */
  includeHappierMcpServer?: boolean;
  /** Admitted Agent identity/socket root supplied by the Machine launch owner. */
  localTransport?: SessionMcpLocalTransportOptions;
  /** Installed payload selected by the isolated Agent's launch owner. */
  managedHappierBinaryPath?: string;
  /** Actual held Machine policy, never a caller-selected execution identity. */
  isolationEnabled?: boolean;
  /** Explicit private composition fact; never derived from Session metadata. */
  localWorkflow?: boolean;
  /** Existing Session-open authority, held privately by its composition owner. */
  readExecutionSource?: (signal?: AbortSignal) => Promise<McpExecutionSource>;
  /** Same admitted Session native/material owner, bound before catalog reads. */
  admittedStdio?: AdmittedMcpStdioRuntime;
  /**
   * Binds this resolution to one Session-owned Execution Run occurrence.
   *
   * The parent Session stays the resource scope and keeps its own configured
   * server profile; only permission mode, working location, runtime lifetime and
   * turn authority come from the Run. The Run's concurrently active parent turn
   * is never substituted for it.
   */
  executionRun?: ExecutionRunMcpBinding;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: import('@/settings/secrets/savedSecretCatalog').SavedSecretCatalogState;
}>;

export type RunnerMcpRuleObservation = Readonly<{
  context: ReachContextV1;
  settings: McpServersSettingsV1;
  mcpPluginItems: readonly McpPluginItemV1[];
  catalog?: Readonly<{ revision: number | 'absent'; authority: 'active' | 'inactive' }>;
}>;

type RunnerMcpServersResult<Bridge extends { stop: () => void | Promise<void> }> = Readonly<{
  happierMcpServer: Bridge;
  /** Host-private current carrier; never persisted or exposed in command arguments. */
  sessionMcpContext?: SessionMcpLocalContext;
  /** Same-UID launch reference only; isolated launches publish through their frame. */
  agentEnvironment?: Readonly<Record<string, string>>;
  mcpServers: Record<string, McpServerConfig>;
  /** Published only by the existing Agent-launch frame owner. */
  selectedMaterials?: readonly AgentLaunchSelectedMaterial[];
  prepareTransport?: PrepareMcpStdioTransport;
  mcpServersStrictMode?: boolean;
  codeMode?: NonNullable<SessionMcpCustomToolsBridge['codeMode']>;
  mcpServerIdentities?: Readonly<Record<string, McpServerIdentity>>;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  resolveMcpToolNaming?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionMcpService['resolveToolNaming'];
  resolvedServers?: readonly ResolvedSessionMcpServer[];
  /** Captured launch resolution; later Account hydration cannot replace its baseline. */
  reach?: RunnerMcpRuleObservation & Readonly<{ selectedServerIds: readonly string[] }>;
}>;
type HappierMcpServerHandle = {
  supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[];
  stop: () => Promise<void>;
};
type HappierMcpBridgeHandle = HappierMcpServerHandle & {
  url: string;
  localContext?: SessionMcpLocalContext;
  contextFilePath?: string;
  readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>;
};
/** The result when the built-in Happier MCP bridge is included (the default). */
export type RunnerMcpServersBridgeResult = RunnerMcpServersResult<HappierMcpBridgeHandle>;

export function resolveRunnerMcpServers(params: RunnerMcpServersParams & { includeHappierMcpServer?: true }): Promise<RunnerMcpServersResult<HappierMcpBridgeHandle>>;
export function resolveRunnerMcpServers(params: RunnerMcpServersParams & { includeHappierMcpServer: false }): Promise<RunnerMcpServersResult<HappierMcpServerHandle>>;
export function resolveRunnerMcpServers(params: RunnerMcpServersParams): Promise<RunnerMcpServersResult<HappierMcpServerHandle>>;
export async function resolveRunnerMcpServers(params: RunnerMcpServersParams): Promise<RunnerMcpServersResult<HappierMcpServerHandle>> {
  const pluginAttachments: Readonly<{ dispose(): void | Promise<void> }>[] = [];
  const disposePluginAttachments = async () => {
    await Promise.all(pluginAttachments.splice(0).map(async attachment => {
      try { await attachment.dispose(); }
      catch (error) { logger.debug('[mcp] Plugin attachment cleanup failed', { error }); }
    }));
  };
  // A daemon preparation may already hold a registry before selection or native
  // bridge construction. Every failed preparation phase retires that lease.
  try {
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  const recordStartupPhase = (phase: string, details?: Readonly<{
    selectedServers?: readonly Readonly<{ serverId: string; wireName: string }>[];
    materializedServers?: readonly Readonly<{ serverId?: string; wireName: string }>[];
    refusalCode?: string;
    requestId?: string;
  }>) => {
    const now = performance.now();
    logger.infoFile('[mcp] Startup phase', { sessionId: params.session.sessionId, phase,
      durationMs: Math.round(now - phaseStartedAt), elapsedMs: Math.round(now - startedAt), ...details });
    phaseStartedAt = now;
  };
  recordStartupPhase('entered');
  const env = params.env ?? sessionProcessEnvironment();
  const accountCredentials = Object.hasOwn(params, 'accountCredentials')
    ? params.accountCredentials ?? null
    : params.credentials;
  const hasResolvedExtras = Object.keys(params.resolvedMcpServers ?? {}).length > 0;
  const managedMcpExplicitlyEmpty = !hasResolvedExtras && hasExplicitlyEmptyManagedMcpSelection(params.sessionMetadata);
  // Restricted Session authority omits Account catalog credentials, not its
  // already-bound requester identity. The reviewed standalone endpoint has no
  // daemon requester custody and supplies only its own sealed host config.
  const needsRequesterSource = !managedMcpExplicitlyEmpty && (accountCredentials !== null
    || hasResolvedExtras && params.credentials.requesterSessionCredentialScope !== undefined);
  const sourceSignal = params.executionRun?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined;
  let executionSource = needsRequesterSource ? params.readExecutionSource
    ? await params.readExecutionSource(sourceSignal) : await readMcpExecutionSource({ credentials: params.credentials,
    localWorkflow: params.localWorkflow,
    ...(accountCredentials ? { catalogCredentials: accountCredentials } : {}), sessionId: params.session.sessionId, machineId: params.machineId,
    serverHttpBaseUrl: params.session.getServerBinding().serverUrl,
    signal: sourceSignal }) : null;
  // One stdio admission per resolution; later selections reuse its qualified source.
  let stdioAdmitted = false;
  const admitStdio = async (signal: AbortSignal | undefined) => {
    if (stdioAdmitted) return;
    executionSource = await assertMcpStdioExecutionSupported(executionSource!, params.isolationEnabled, signal);
    stdioAdmitted = true;
  };
  if (executionSource && hasResolvedExtras && !params.admittedStdio) {
    await admitStdio(params.executionRun?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined);
  }
  let operationContext = accountCredentials ? params.operationContext : undefined;
  const initialAccountSnapshot = managedMcpExplicitlyEmpty ? null : params.accountSettingsSnapshot;
  if (accountCredentials && !operationContext && initialAccountSnapshot
    && initialAccountSnapshot === getActiveAccountSettingsSnapshot()) {
    // Ordinary Home callers use this same admitted Account owner. Capture its
    // existing lifetime before bridge startup, never after an awaited boundary.
    // Foreign invocation snapshots still require their explicit context.
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const scopeKey = initialAccountSnapshot.scopeKey;
    const serverHttpBaseUrl = params.session.getServerBinding().serverUrl;
    const boundScopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(accountCredentials.token));
    if (!scopeKey || scopeKey !== boundScopeKey) throw new McpServerCatalogUnavailableError('scope-retired');
    operationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
      credentials: accountCredentials, snapshot: initialAccountSnapshot, serverHttpBaseUrl,
      isCurrent: async () => getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
        && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken,
    }));
  }
  if (operationContext && (operationContext.credentials.token !== accountCredentials?.token || !await operationContext.isCurrent())) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  recordStartupPhase('account_authority');
  let accountSettings = accountCredentials ? params.accountSettings ?? params.accountSettingsSnapshot?.settings ?? null : null;
  let savedSecretResources = params.savedSecretResources;
  let savedSecretCatalogState = params.savedSecretCatalogState;

  const run = params.executionRun;
  const scopedSession: HappyMcpSessionClient = run
    ? createRunScopedMcpSessionView(params.session, run)
    : params.session;
  const featureSnapshot = scopedSession.getServerFeaturesSnapshot?.();
  const codeModeEnabled = featureSnapshot?.status === 'ready'
    && readServerEnabledBit(featureSnapshot.features, 'sessions.codeMode') === true;
  const readConfinement = () => params.unlistedTools === 'deny'
    || (scopedSession.getMetadataSnapshot?.() ?? params.sessionMetadata)?.unlistedTools === 'deny'
    || String(scopedSession.getPermissionMode?.()) === 'no_tools';
  const scriptRunner = codeModeEnabled && params.scriptRunnerEnabled === true
    && supportsSessionMcpLocalTransport() && !readConfinement();
  let codeMode = { bootstrap: scriptRunner, scriptRunner };
  const nativeMcpEligible = params.agentAcceptsUserMcp ?? params.agentId == null;
  const selectForSessionTools = codeModeEnabled || params.localTransport !== undefined;
  const accountSnapshot = initialAccountSnapshot ?? null;
  const accountScopeKey = accountCredentials ? operationContext
    ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(accountCredentials.token))
    : resolveAccountSettingsScopeKeyForToken(accountCredentials.token) : null;
  if (accountCredentials && accountSnapshot?.scopeKey
    && accountSnapshot.scopeKey !== accountScopeKey) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  const nativeDiscoveryNotices: SessionCapabilityNoticeV1['items'] = [];
  const publishCapabilityNotice = async (items: SessionCapabilityNoticeV1['items']) => {
    const notice = SessionCapabilityNoticeV1Schema.parse({ v: 1, items: [...nativeDiscoveryNotices, ...items] });
    items = notice.items;
    const previous = SessionCapabilityNoticeV1Schema.safeParse(
      (params.session.getMetadataSnapshot?.() ?? params.sessionMetadata)?.mcpCapabilityNoticeV1,
    );
    const facts = (value: SessionCapabilityNoticeV1) => JSON.stringify(value.items.map(item =>
      JSON.stringify([item.kind, item.itemId ?? null, item.name, item.code, item.detail ?? null])).sort());
    if (previous.success ? facts(previous.data) === facts(notice) : items.length === 0) return;
    if (items.length > 0) {
      // A changed set is a new transcript entry, including a return to an old
      // failure. The existing journal owns retries of this particular entry.
      const admitted = await params.session.enqueueSessionEventCommitted({
        type: 'message',
        message: notice.items.map(item => `${item.name} couldn't start · ${item.detail ?? item.code}`).join('\n'),
        [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice,
      }, `capability-notice:${randomUUID()}`, { awaitDelivery: false });
      if (!admitted.persisted) return;
    }
    if (operationContext && !await operationContext.isCurrent()) {
      throw new McpServerCatalogUnavailableError('scope-retired');
    }
    // Retain only the last observed failure set in the Session's existing
    // private metadata. An empty set records recovery without inventing copy.
    await params.session.updateMetadata(metadata => ({ ...metadata, mcpCapabilityNoticeV1: notice }));
  };
  let mcpSettings: ReturnType<typeof readMcpServersSettingsFromAccountSettings> | null = null;
  if (accountCredentials && !managedMcpExplicitlyEmpty) {
    const startup = readMcpServersSettingsForStartup({ snapshot: accountSnapshot, settings: accountSettings });
    if (startup.status === 'ready') mcpSettings = startup.settings;
    else await publishCapabilityNotice([{ kind: 'mcp_server', name: 'MCP servers', code: startup.error.code, detail: startup.error.reason }]);
  }
  recordStartupPhase('catalog_admission');
  let mcpCatalog = accountSnapshot?.mcpServerCatalog;
  const pluginRegistry = params.pluginMcpRuntimeRegistry ?? params.pluginRuntimeRegistryLease?.registry ?? params.session.getPluginMcpRuntimeRegistry?.();
  const pluginPort = params.session.getPluginMcpPort?.();
  let daemonPluginPreparation: import('./pluginMcpPort').PluginMcpPreparation | null = null;
  let mcpPluginItems: readonly McpPluginItemV1[] = [];
  if (mcpSettings && mcpCatalog?.status === 'ready') {
    if (pluginPort) {
      daemonPluginPreparation = await pluginPort.prepare({ catalog: mcpCatalog.catalog, directory: params.directory,
        signal: run?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined });
      pluginAttachments.push(daemonPluginPreparation);
      mcpPluginItems = daemonPluginPreparation.items;
    } else if (pluginRegistry?.projectMcpServerItems) {
      // Daemonless runtimes retain their explicitly supplied executable owner.
      mcpPluginItems = await pluginRegistry.projectMcpServerItems(mcpCatalog.catalog);
    }
  }
  recordStartupPhase('plugin_projection');
  const detected = params.detectedMcpServers ?? [];
  const nativeServerNames = readLoadedMcpNativeServerNames({ servers: detected, agentId: params.agentId });
  let resolvedSelection: Awaited<ReturnType<typeof resolveSessionCapabilitiesForDirectory>> | null = null;
  const selectedServerFacts = (selection: NonNullable<typeof resolvedSelection>) =>
    Object.values(selection.selectedServersByName).map(({ serverId, name }) => ({ serverId, wireName: name }));
  if (mcpSettings && accountCredentials) {
    const initialSettings = mcpSettings;
    const selection = readSessionCapabilitySelectionFromMetadataV1(params.sessionMetadata ?? null).mcp;
    const serverBinding = params.session.getServerBinding();
    const projectInput = { credentials: accountCredentials, metadata: params.sessionMetadata ?? null,
      serverId: serverBinding.serverId, signal: run?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined,
      ...(operationContext ? { operationContext } : {}) };
    const initialSelection = await runWithServerHttpBaseUrl(serverBinding.serverUrl, () => resolveSessionCapabilitiesForDirectory({
      settings: initialSettings,
      machineId: params.machineId,
      directory: params.directory,
      selection: selection ? { mcp: selection } : {},
      agentId: params.agentId,
      agentAcceptsUserMcp: nativeMcpEligible || selectForSessionTools,
      sessionProject: projectInput,
      mcpPluginItems, nativeServerNames,
    }));
    resolvedSelection = initialSelection;
    if (!params.admittedStdio && Object.values(initialSelection.selectedServersByName).some(server => server.enabled)) {
      await admitStdio(run?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined);
    }
    recordStartupPhase('capability_selection', { selectedServers: selectedServerFacts(initialSelection) });
    const sharedReferences = listSelectedMcpSharedSecretReferences(initialSelection.selectedServersByName);
    if (sharedReferences.length > 0) {
      let admitted: Awaited<ReturnType<typeof refreshSavedSecretCatalogForOperation>>;
      try {
        const refresh = () => refreshSavedSecretCatalogForOperation({
          expectedScopeKey: resolveAccountSettingsScopeKeyForToken(accountCredentials.token),
          references: sharedReferences,
          ...(operationContext ? { operationContext } : {}),
          ...(run?.signal ? { signal: run.signal } : {}),
        });
        admitted = await (operationContext ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, refresh) : refresh());
      } catch (error) {
        if (error instanceof SavedSecretOperationAdmissionError) {
          throw new SavedSecretResolutionError({
            status: savedSecretOperationAdmissionStatus(error.reason),
            reference: error.reference,
            consumer: 'mcp',
            field: 'operation',
          });
        }
        throw error;
      }
      accountSettings = admitted.settings;
      recordStartupPhase('saved_secret_admission');
      savedSecretResources = admitted.savedSecretResources;
      savedSecretCatalogState = admitted.savedSecretCatalogState;
      const refreshedSettings = readMcpServersSettingsFromAccountSettings({ ...admitted, mcpServerCatalog: admitted.mcpServerCatalog ?? accountSnapshot?.mcpServerCatalog });
      mcpSettings = refreshedSettings;
      mcpCatalog = admitted.mcpServerCatalog ?? accountSnapshot?.mcpServerCatalog;
      resolvedSelection = await runWithServerHttpBaseUrl(serverBinding.serverUrl, () => resolveSessionCapabilitiesForDirectory({
        settings: refreshedSettings,
        machineId: params.machineId,
        directory: params.directory,
        selection: selection ? { mcp: selection } : {},
        agentId: params.agentId,
        agentAcceptsUserMcp: nativeMcpEligible || selectForSessionTools,
        projectKey: initialSelection.projectKey,
        sessionProject: projectInput,
        mcpPluginItems, nativeServerNames,
      }));
      recordStartupPhase('capability_reselection', { selectedServers: selectedServerFacts(resolvedSelection) });
    }
  }
  if (resolvedSelection && Object.values(resolvedSelection.selectedServersByName).some(server => server.enabled)) {
    if (!params.admittedStdio) await admitStdio(run?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined);
    // Native config reads happen in the plugin host's filesystem, not under an
    // Agent UID. Only an admitted selected profile can request name collision
    // discovery; an empty profile needs no native host configuration.
    const discoverySignal = run?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined;
    const nativeServers = params.detectedMcpServers ?? (daemonPluginPreparation
      ? await daemonPluginPreparation.discoverNativeServers().catch(error => {
        if (!isPluginError(error) || error.code !== 'requester_native_discovery_unavailable') throw error;
        const requestId = readPluginErrorRequestIdV1(error);
        nativeDiscoveryNotices.push({ kind: 'mcp_server', name: 'Native MCP discovery', code: error.code,
          detail: 'Native MCP configuration cannot be discovered as this member. Selected MCP servers remain available.',
          ...(requestId === undefined ? {} : { requestId }) });
        return [];
      })
      : pluginRegistry?.discoverMcpServersForDetection && params.agentId
        ? (await detectProviderMcpServers({ directory: params.directory, providers: [params.agentId], env,
          sessionId: params.session.sessionId, signal: discoverySignal, runtimeRegistry: pluginRegistry })).servers : []);
    discoverySignal?.throwIfAborted();
    const nativeNames = readLoadedMcpNativeServerNames({ servers: nativeServers, agentId: params.agentId });
    if (nativeNames.length > 0) {
      const serverBinding = params.session.getServerBinding();
      const selection = readSessionCapabilitySelectionFromMetadataV1(params.sessionMetadata ?? null).mcp;
      resolvedSelection = await runWithServerHttpBaseUrl(serverBinding.serverUrl, () => resolveSessionCapabilitiesForDirectory({
        settings: mcpSettings!, machineId: params.machineId, directory: params.directory,
        selection: selection ? { mcp: selection } : {}, agentId: params.agentId, agentAcceptsUserMcp: nativeMcpEligible || selectForSessionTools,
        projectKey: resolvedSelection!.projectKey, mcpPluginItems, nativeServerNames: nativeNames,
      }));
    }
    recordStartupPhase('native_discovery', {
      ...(nativeNames.length > 0 ? { selectedServers: selectedServerFacts(resolvedSelection) } : {}),
      refusalCode: nativeDiscoveryNotices[0]?.code,
      requestId: nativeDiscoveryNotices[0]?.requestId,
    });
  }
  if (operationContext && !await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
  recordStartupPhase('account_currentness');
  const emptyMcpServers: Record<string, McpServerConfig> = {};
  const customServers = new Map<string, SessionCustomMcpServer>();
  const onDemandNames = new Set<string>();
  if (codeModeEnabled && mcpSettings && resolvedSelection) {
    for (const [name, server] of Object.entries(resolvedSelection.selectedServersByName)) {
      const policy = mcpSettings.pluginServers?.[server.serverId]?.tools ?? server.config.tools;
      if (server.enabled && resolveMcpToolLoadingV1(policy) === 'on_demand') onDemandNames.add(name);
    }
    codeMode = { scriptRunner, bootstrap: scriptRunner || (!readConfinement() && onDemandNames.size > 0) };
  }
  let customIdentities: Readonly<Record<string, McpServerIdentity>> = {};
  let selectedMaterials: readonly AgentLaunchSelectedMaterial[] = [];
  const pool = createSessionCustomMcpClientPool({
    processEnv: params.admittedStdio?.environment ?? env,
    signal: sourceSignal,
    isCurrent: operationContext?.isCurrent,
    ...(params.admittedStdio ? { prepareTransport: (config, signal) => params.admittedStdio!.prepareTransport({
      config, selectedMaterials, signal,
    }) } : {}),
  });
  const customBridge = createSessionMcpCustomToolsBridge({
    pool,
    readServers: () => customServers,
    isConfined: readConfinement,
    async authorize(input, signal) {
      if (!params.mcpPermissionHandler) return { ok: false, errorCode: 'approval_required', error: 'Tool approval is required.' };
      const witness = scopedSession.getActiveTurnAdmissionWitness?.();
      const mode = String(scopedSession.getPermissionMode?.() ?? 'default');
      const wireName = formatMcpToolWireNameV1(input.source, input.toolName);
      const requestId = input.toolCallId ? `${input.toolCallId}:${wireName}:${randomUUID()}` : randomUUID();
      const decision = await params.mcpPermissionHandler.handleToolCall(requestId,
        wireName, input.args, {
          buildNativeChoices: facts => createMcpPermissionChoices('mcp.tool', facts.mcpTool),
          signal,
          ...(witness ? { turnId: witness.turnId, causalPermissionAuthority: witness.causalPermissionAuthority ?? null } : {}),
          callerPermissionMode: mode,
          mcpToolPolicy: { permissionMode: mode, readContext: () => ({
            mcpServerIdentities: customIdentities,
            catalog: operationContext?.readSnapshot()?.mcpServerCatalog ?? accountSnapshot?.mcpServerCatalog ?? null,
          }) },
        });
      if (decision.decision === 'denied' || decision.decision === 'abort') {
        return { ok: false, errorCode: decision.decision === 'abort' ? 'cancelled' : 'permission_denied', error: 'Tool execution was not approved.' };
      }
      const binding = customIdentities[input.source]?.usage;
      if (!witness || !binding) return { ok: true };
      const deferred = onDemandNames.has(input.source);
      return { ok: true, recordUsage(startMs, observedAtMs) {
        observedAtMs = Math.max(startMs, observedAtMs);
        const evidenceId = randomUUID();
        void params.session.enqueueSessionEventCommitted({
          type: 'mcp-binding-usage',
          usage: { v: 2, evidenceId, sessionId: scopedSession.sessionId, turnId: witness.turnId,
            observedAtMs, window: { startMs, endMs: observedAtMs }, coverage: 'partial',
            bindings: [{ ...binding, toolCallCount: 1, schemaBytes: deferred ? 0 : null,
              ...(deferred ? { definitionsLoading: 'deferred', schemaTokens: 0 } : {}) }],
          },
        }, evidenceId, { awaitDelivery: false }).catch(() => logger.debug('[mcp] Tool usage publication failed'));
      } };
    },
  });
  const sessionToolsBridge: SessionMcpCustomToolsBridge = { ...customBridge, get codeMode() { return codeMode; } };
  const setCustomServers = (connections: NonNullable<Awaited<ReturnType<typeof materializeMcpServerConfigRecord>>['sessionConnections']>) => {
    for (const [source, connection] of Object.entries(connections)) {
      if (source === 'happier') continue;
      const selected = resolvedSelection?.selectedServersByName[source];
      const id = selected?.serverId ?? source;
      const settings = mcpSettings?.pluginServers?.[id] ?? selected?.config;
      customServers.set(source, { id, source, connection, settings });
    }
  };
  const resolvedExtras = params.resolvedMcpServers ? Object.fromEntries(Object.entries(params.resolvedMcpServers)
    .map(([name, config]) => [name, { kind: 'stdio' as const, config }])) : undefined;
  if (resolvedExtras) setCustomServers(resolvedExtras);
  const builtIn = params.includeHappierMcpServer === false && !params.localTransport
    ? { happierMcpServer: { supportedSessionReadActions: [], stop: async () => undefined, localContext: undefined, contextFilePath: undefined }, mcpServers: emptyMcpServers }
    : await createHappierMcpBridge(scopedSession, {
    sessionToolsBridge,
    sessionMetadata: params.sessionMetadata ?? params.session.getMetadataSnapshot?.(),
    ...(params.localTransport ? { localTransport: params.localTransport } : {}),
    managedHappierBinaryPath: params.managedHappierBinaryPath,
    mcpToolCallIdMetaKey: params.mcpToolCallIdMetaKey,
    commandMode: params.commandMode,
    sessionCredentials: params.credentials,
    credentials: accountCredentials,
    ...(operationContext ? { isCredentialCurrent: operationContext.isCurrent } : {}),
    authorityScope: accountCredentials ? 'account' : 'session',
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    accountSettings,
    ...(params.actionsSettingsProvider
      ? { actionsSettingsProvider: params.actionsSettingsProvider }
      : {}),
    ...(params.pluginRuntimeRegistryLease
      ? { pluginRuntimeRegistryLease: params.pluginRuntimeRegistryLease }
      : {}),
    requiredDirectActionIds: run ? SESSION_RUN_PROMPT_READ_ACTION_IDS_V1 : undefined,
  }).catch(async error => {
    await pool.dispose();
    throw error;
  });
  const ownedBridge = {
    ...builtIn.happierMcpServer,
    get localContext() { return builtIn.happierMcpServer.localContext; },
    stop: async () => {
      try { await builtIn.happierMcpServer.stop(); }
      finally { await pool.dispose(); }
    },
  };
  // The one mapping of an Agent's context file (a placed Session's Agents are named none: `sessionTargetRelay.ts`).
  const nativeContextFile = params.admittedStdio && builtIn.happierMcpServer.localContext
    ? resolveSessionAgentMcpContextFile(sessionMcpAgentLaunchContextFile(params.admittedStdio.target.runtimeHome)) : undefined;
  const nativeBuiltInServers = nativeContextFile && builtIn.mcpServers.happier ? {
    ...builtIn.mcpServers, happier: { ...builtIn.mcpServers.happier,
      env: { ...builtIn.mcpServers.happier.env, [SESSION_MCP_CONTEXT_FILE_ENV]: nativeContextFile } },
  } : builtIn.mcpServers;
  const advertisedBuiltInMcpServers = params.includeHappierMcpServer === false ? emptyMcpServers : nativeBuiltInServers;
  const contextFile = nativeContextFile ?? builtIn.happierMcpServer.contextFilePath;
  const cliBinary = scriptRunner ? params.managedHappierBinaryPath
    ?? (await import('@/utils/spawnHappyCLI')).buildHappyCliSubprocessLaunchSpec([], { environment: env }) : undefined;
  const agentEnvironment = contextFile
    ? Object.freeze({ [SESSION_MCP_CONTEXT_FILE_ENV]: contextFile,
      ...(typeof cliBinary === 'string' ? { HAPPIER_CLI_BIN: cliBinary }
        : cliBinary?.runtime === 'binary' ? { HAPPIER_CLI_BIN: cliBinary.filePath } : {}),
    }) : undefined;
  const readAgentEnvironment = () => builtIn.happierMcpServer.localContext ? agentEnvironment : undefined;

  const naming = 'readToolNames' in builtIn.happierMcpServer && nativeBuiltInServers.happier
    ? { resolveMcpToolNaming: createHappierMcpToolNamingResolver(nativeBuiltInServers.happier, builtIn.happierMcpServer.readToolNames) }
    : {};
  recordStartupPhase('builtin_bridge');

  if (operationContext && !await operationContext.isCurrent()) {
    await ownedBridge.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  recordStartupPhase('account_currentness');

  if (!accountSettings || !accountCredentials) {
    await disposePluginAttachments();
    recordStartupPhase('completed');
    return { ...naming, happierMcpServer: ownedBridge,
      get sessionMcpContext() { return builtIn.happierMcpServer.localContext; },
      get agentEnvironment() { return readAgentEnvironment(); }, codeMode,
      mcpServers: params.resolvedMcpServers ? mergeWithBuiltInHappierMcpServer({ builtIn: advertisedBuiltInMcpServers, extra: params.resolvedMcpServers }) : advertisedBuiltInMcpServers };
  }

  if (!mcpSettings || !resolvedSelection) {
    await disposePluginAttachments();
    recordStartupPhase('completed');
    return { ...naming, happierMcpServer: ownedBridge,
      get sessionMcpContext() { return builtIn.happierMcpServer.localContext; },
      get agentEnvironment() { return readAgentEnvironment(); }, codeMode,
      mcpServers: advertisedBuiltInMcpServers };
  }

  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(accountCredentials);
  const invocationSnapshot = operationContext ? operationContext.readSnapshot() : accountSnapshot;
  if (operationContext && !invocationSnapshot) {
    await ownedBridge.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  const savedSecretMaterializer = invocationSnapshot
    ? await acquireSavedSecretMaterializerForOperation({ snapshot: invocationSnapshot,
      references: listSelectedMcpSharedSecretReferences(resolvedSelection.selectedServersByName), operationContext, signal: sourceSignal, secretSources: pluginRegistry?.secretSources })
    : createSavedSecretMaterializerV1({
    accountSettings,
    settingsSecretsReadKeys,
    resources: savedSecretResources,
    resourceCatalogState: savedSecretCatalogState,
  });

  const attestation = SessionAttestedContextV1Schema.safeParse(params.session.getMetadataSnapshot?.()?.attestedContext);
  const requestAuthByServerId: Record<string, McpRequestAuthCapability> = {};
  const requestAuthFailuresByServerId: Record<string, McpRequestAuthFailureCode> = {};
  const requestAuthDiagnosticsByServerId: Record<string, Readonly<{
    failureCode: ReturnType<typeof readMcpRequestAuthDiagnosticCode>;
    failureCheckpoint: 'request_auth_port' | 'request_auth_open' | 'daemon_service_dispatch';
  }>> = {};
  const requestAuthPort = scopedSession.getMcpRequestAuthPort?.();
  const materializationIds = new Set<string>();
  const retireRequestAuth = async () => {
    const retiring: Promise<unknown>[] = [];
    for (const materializationId of materializationIds) {
      materializationIds.delete(materializationId);
      const retirement = requestAuthPort?.close({ materializationId }).catch(() => {
        logger.debug('[mcp] Request-auth capability retirement failed');
      });
      if (retirement) retiring.push(retirement);
    }
    await Promise.all(retiring);
  };
  let materialized: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>>;
  try {
    if (daemonPluginPreparation || pluginRegistry?.materializePluginMcpServers) {
      const selected = Object.values(resolvedSelection.selectedServersByName).map(server => ({
        id: server.serverId, name: server.name, title: server.config.title,
        transport: server.config.remote ? { kind: server.config.transport === 'sse' ? 'sse' as const : 'http' as const, url: server.config.remote.url }
          : { kind: 'stdio' as const }, scope: { sessionId: params.session.sessionId, directory: params.directory },
      }));
      const attached = daemonPluginPreparation ? await daemonPluginPreparation.materialize(selected)
        : await pluginRegistry!.materializePluginMcpServers!({ scope: { kind: 'session', sessionId: params.session.sessionId }, directory: params.directory,
        permissionHandler: params.mcpPermissionHandler,
        servers: selected, signal: run?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined,
        addDisposable: attachment => pluginAttachments.push(attachment) });
      resolvedSelection = { ...resolvedSelection, selectedServersByName: Object.fromEntries(attached.map(server => [server.name,
        applyAttachedPluginMcpTransport(resolvedSelection!.selectedServersByName[server.name]!, server.transport)])) };
    }
    recordStartupPhase('plugin_materialization');
    const authIssuances = await Promise.allSettled(Object.values(resolvedSelection.selectedServersByName).map(async ({ config: server }) => {
      const remote = server.remote;
      if (server.transport === 'stdio' || remote?.auth?.kind !== 'oauth') return;
      if (!requestAuthPort) {
        requestAuthFailuresByServerId[server.id] = 'mcp_request_auth_unavailable';
        requestAuthDiagnosticsByServerId[server.id] = { failureCode: 'mcp_request_auth_unavailable', failureCheckpoint: 'request_auth_port' };
        return;
      }
      const materializationId = randomUUID();
      const occurrence = run?.readCurrentRunOccurrence(run.runId);
      if (run && (!occurrence || !run.isCurrent() || run.signal.aborted)) throw new Error('mcp_request_auth_not_active');
      try {
        const capability = await requestAuthPort.open({
          serverId: server.id,
          resource: canonicalMcpOAuthResourceUrlV1(remote.url),
          materializationId,
          ...(daemonPluginPreparation && isMcpPluginItemIdV1(server.id)
            ? { pluginPreparationId: daemonPluginPreparation.preparationId } : {}),
          ...(run && occurrence ? { executionRun: { runId: run.runId, occurrenceId: occurrence.occurrenceId } } : {}),
        });
        materializationIds.add(materializationId);
        requestAuthByServerId[server.id] = capability;
      } catch (error) {
        requestAuthFailuresByServerId[server.id] = readMcpRequestAuthFailureCode(error);
        requestAuthDiagnosticsByServerId[server.id] = readMcpRequestAuthFailureDiagnostic(error);
        // The materializer owns strict refusal versus optional omission, using
        // the safe failure code rather than the port's private exception text.
      }
    }));
    // Every open owns a distinct capability. Join before materialization or
    // cleanup so a late successful sibling cannot escape the profile lifetime.
    for (const issuance of authIssuances) if (issuance.status === 'rejected') throw issuance.reason;
    recordStartupPhase('request_auth');
    materialized = await materializeMcpServerConfigRecord({
    resolved: {
      directory: params.directory,
      strictMode: resolvedSelection.strictMode,
      serversByName: resolvedSelection.selectedServersByName,
    },
    savedSecretMaterializer,
    session: { sessionId: params.session.sessionId,
      ...(attestation.success ? { attestedContext: attestation.data } : {}) },
    processEnv: params.admittedStdio?.environment ?? env,
    tmpDir: params.tmpDir ?? null,
    signal: sourceSignal,
    agentLaunchTarget: params.admittedStdio?.target,
    strictMode: mcpSettings.strictMode,
    requestAuthByServerId,
    requestAuthFailuresByServerId,
    sessionConnections: { hostOnlyNames: nativeMcpEligible ? onDemandNames
      : new Set(Object.keys(resolvedSelection.selectedServersByName)) },
  });
    recordStartupPhase('config_materialization', {
      materializedServers: Object.keys(materialized.mcpServers).map(wireName => ({
        serverId: resolvedSelection?.itemsByName[wireName]?.serverId, wireName,
      })),
    });
  } catch (error) {
    await ownedBridge.stop();
    await retireRequestAuth();
    await disposePluginAttachments();
    throw error;
  }
  if (operationContext && !await operationContext.isCurrent()) {
    await ownedBridge.stop();
    materialized.cleanup();
    await retireRequestAuth();
    await disposePluginAttachments();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  recordStartupPhase('account_currentness');

  if (materialized.warnings.length > 0) {
    logger.debug('[mcp] Materialization warnings', {
      warningCount: materialized.warnings.length,
      warnings: materialized.warnings.map((w) => ({ serverName: w.serverName, code: w.code,
        serverId: resolvedSelection.itemsByName[w.serverName]?.serverId,
        ...requestAuthDiagnosticsByServerId[resolvedSelection.itemsByName[w.serverName]?.serverId ?? ''] })),
    });
  }
  selectedMaterials = materialized.selectedMaterials ?? [];
  if (!resolvedExtras) setCustomServers(materialized.sessionConnections ?? {});
  const deferredServers = readConfinement() ? [] : [...onDemandNames]
    .filter(name => customServers.has(name))
    .map(name => resolvedSelection.itemsByName[name]?.name ?? name)
    .sort((a, b) => a.localeCompare(b));
  codeMode = { scriptRunner, bootstrap: scriptRunner || deferredServers.length > 0,
    ...(deferredServers.length > 0 ? { onDemandServers: deferredServers } : {}) };
  customIdentities = Object.fromEntries(params.resolvedMcpServers ? [] : [...customServers.keys()].flatMap(name => {
    const item = resolvedSelection.itemsByName[name];
    const server = mcpSettings.servers.find(server => server.id === item?.serverId);
    const identity = resolvedSelection.mcpServerIdentities[name];
    if (!identity) return [];
    if (!server) return [[name, identity]];
    const binding = item?.bindingId ? mcpSettings.bindings.find(binding => binding.id === item.bindingId && binding.serverId === server.id) : undefined;
    const usage = binding?.enabled && mcpCatalog?.status === 'ready' && mcpCatalog.authority === 'active' && typeof mcpCatalog.revision === 'number'
      ? { serverId: server.id, bindingId: binding.id, serverRevision: server.updatedAt, bindingRevision: binding.updatedAt, catalogRevision: mcpCatalog.revision } : undefined;
    return [[name, { ...identity, ...(usage ? { usage } : {}) }]];
  })) as Record<string, McpServerIdentity>;
  const extra = params.resolvedMcpServers ?? materialized.mcpServers;
  const merged = mergeWithBuiltInHappierMcpServer({ builtIn: advertisedBuiltInMcpServers, extra });
  const warningsByName = new Map(materialized.warnings
    .filter(warning => !Object.hasOwn(merged, warning.serverName))
    .map(warning => [warning.serverName, warning]));
  try {
    await publishCapabilityNotice([...warningsByName.values()].map(warning => ({
      kind: 'mcp_server', name: warning.serverName,
      itemId: resolvedSelection.itemsByName[warning.serverName]?.serverId,
      code: warning.code, detail: warning.detail,
    })));
  } catch (error) {
    await ownedBridge.stop();
    materialized.cleanup();
    await retireRequestAuth();
    await disposePluginAttachments();
    throw error;
  }
  recordStartupPhase('capability_notice');

  const mcpServerIdentities = Object.fromEntries(Object.keys(materialized.mcpServers).flatMap(name =>
    customIdentities[name] ? [[name, customIdentities[name]]] : []));
  const mcpToolPolicy = projectMcpToolLaunchPolicies({ catalog: { v: 1, servers: mcpSettings.servers, bindings: mcpSettings.bindings, ...(mcpSettings.pluginServers ? { pluginServers: mcpSettings.pluginServers } : {}) },
    mcpServerIdentities, control: params.mcpToolControl, permissionMode: parseAgentPermissionIntentV1Alias(String(scopedSession.getPermissionMode?.() ?? 'default')) ?? 'default' });
  recordStartupPhase('completed');
  return {
    ...naming,
    happierMcpServer: {
      ...ownedBridge,
      get localContext() { return builtIn.happierMcpServer.localContext; },
      stop: async () => {
        try { await ownedBridge.stop(); }
        finally {
          try { await materialized.cleanup(); }
          finally { await retireRequestAuth(); await disposePluginAttachments(); }
        }
      },
    },
    get sessionMcpContext() { return builtIn.happierMcpServer.localContext; },
    get agentEnvironment() { return readAgentEnvironment(); },
    codeMode,
    mcpServers: merged,
    ...(materialized.selectedMaterials ? { selectedMaterials: materialized.selectedMaterials } : {}),
    ...(params.admittedStdio ? { prepareTransport: ((config, signal) => params.admittedStdio!.prepareTransport({
      config, selectedMaterials: materialized.selectedMaterials ?? [], signal,
    })) satisfies PrepareMcpStdioTransport } : {}),
    mcpServersStrictMode: mcpSettings.strictMode,
    mcpServerIdentities,
    ...(!params.resolvedMcpServers ? { reach: { context: resolvedSelection.context, settings: mcpSettings, mcpPluginItems,
      ...(mcpCatalog?.status === 'ready' ? { catalog: { revision: mcpCatalog.revision, authority: mcpCatalog.authority } } : {}),
      selectedServerIds: resolvedSelection.mcp.items.filter(item => item.selected).map(item => item.id) } } : {}),
    resolvedServers: projectResolvedMcpServers({ mcpServers: merged, identities: mcpServerIdentities,
      scope: { sessionId: params.session.sessionId, directory: params.directory } }),
    ...(mcpToolPolicy ? { mcpToolPolicy } : {}),
  };
  } catch (error) {
    await disposePluginAttachments();
    throw error;
  }
}
