import type { SessionMcpLocalContext, SessionMcpLocalTransportOptions } from './sessionMcpLocalTransport';
import { SESSION_MCP_CONTEXT_FILE_ENV } from './sessionMcpLocalTransport';
import type { AdmittedMcpStdioRuntime, PrepareMcpStdioTransport } from './supervisedStdioTransport';
import { join } from 'node:path';
import { SESSION_MCP_CONTEXT_RELATIVE_PATH } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { McpServerConfig } from '@/agent';
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
import { projectResolvedMcpServers } from './projectResolvedMcpServers';
import type { McpPluginItemV1, McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { DetectedMcpServerV1 } from '@happier-dev/protocol';
import { projectMcpToolLaunchPolicies } from './projectMcpToolLaunchPolicy';
import type { PluginAgentToolsCapabilityV2 } from '@happier-dev/protocol';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings, readMcpServersSettingsForStartup } from '../servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '../servers/resolveSessionCapabilitiesForDirectory';
import {
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';
import { listSelectedMcpSharedSecretReferences, materializeMcpServerConfigRecord } from '../servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '../servers/mergeWithBuiltInHappierMcpServer';
import {
  createSavedSecretMaterializerV1,
  createSavedSecretMaterializerFromSnapshotV1,
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
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { randomUUID } from 'node:crypto';
import { createHappierMcpToolNamingResolver } from './projectMcpToolNames';
import { readMcpRequestAuthFailureCode, readMcpRequestAuthDiagnosticCode, readMcpRequestAuthFailureDiagnostic, type McpRequestAuthCapability, type McpRequestAuthFailureCode } from './mcpRequestAuth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';

/**
 * The exact Session-owned Run whose authority this MCP profile serves.
 *
 * `readCurrentRunOccurrence` projects the bridge's canonical controller entry,
 * deliberately read per request: the built-in Happier server is rebuilt for each
 * MCP call, so a resumed or replaced controller occurrence must stop supplying
 * authority without rebuilding the server.
 */
export type ExecutionRunMcpBinding = Readonly<{
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
  mcpToolCallIdMetaKey?: PluginAgentToolsCapabilityV2['mcpToolCallIdMetaKey'];
  sessionMetadata?: Readonly<Record<string, unknown>> | null;
  env?: ProcessEnvInput;
  tmpDir?: string | null;
  commandMode?: NonNullable<Parameters<typeof createHappierMcpBridge>[1]>['commandMode'];
  resolvedMcpServers?: Record<string, McpServerConfig>;
  /** Extension-delivered Happier tools already have their own bridge. */
  includeHappierMcpServer?: boolean;
  localTransport?: SessionMcpLocalTransportOptions;
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
  mcpServerIdentities?: Readonly<Record<string, McpServerIdentity>>;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  resolveMcpToolNaming?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionMcpService['resolveToolNaming'];
  resolvedServers?: readonly ResolvedSessionMcpServer[];
  /** Captured launch resolution; later Account hydration cannot replace its baseline. */
  reach?: RunnerMcpRuleObservation & Readonly<{ selectedServerIds: readonly string[] }>;
}>;
type HappierMcpBridgeHandle = {
  url: string;
  localContext?: SessionMcpLocalContext;
  contextFilePath?: string;
  supportedSessionReadActions: readonly SessionRunPromptReadActionIdV1[];
  readToolNames: (signal?: AbortSignal) => Promise<readonly string[]>;
  stop: () => Promise<void>;
};

export function resolveRunnerMcpServers(params: RunnerMcpServersParams & { includeHappierMcpServer?: true }): Promise<RunnerMcpServersResult<HappierMcpBridgeHandle>>;
export function resolveRunnerMcpServers(params: RunnerMcpServersParams & { includeHappierMcpServer: false }): Promise<RunnerMcpServersResult<{ stop: () => Promise<void> }>>;
export function resolveRunnerMcpServers(params: RunnerMcpServersParams): Promise<RunnerMcpServersResult<{ stop: () => Promise<void> }>>;
export async function resolveRunnerMcpServers(params: RunnerMcpServersParams): Promise<RunnerMcpServersResult<{ stop: () => Promise<void> }>> {
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
  const recordStartupPhase = (phase: string) => {
    const now = performance.now();
    logger.infoFile('[mcp] Startup phase', { sessionId: params.session.sessionId, phase,
      durationMs: Math.round(now - phaseStartedAt), elapsedMs: Math.round(now - startedAt) });
    phaseStartedAt = now;
  };
  recordStartupPhase('entered');
  const env = params.env ?? process.env;
  const accountCredentials = Object.hasOwn(params, 'accountCredentials')
    ? params.accountCredentials ?? null
    : params.credentials;
  let operationContext = accountCredentials ? params.operationContext : undefined;
  const initialAccountSnapshot = params.accountSettingsSnapshot;
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
  const accountSnapshot = params.accountSettingsSnapshot ?? null;
  const accountScopeKey = accountCredentials ? operationContext
    ? runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(accountCredentials.token))
    : resolveAccountSettingsScopeKeyForToken(accountCredentials.token) : null;
  if (accountCredentials && accountSnapshot?.scopeKey
    && accountSnapshot.scopeKey !== accountScopeKey) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  const publishCapabilityNotice = async (items: SessionCapabilityNoticeV1['items']) => {
    const notice = SessionCapabilityNoticeV1Schema.parse({ v: 1, items });
    // This optional diagnostic has no delivery-dependent caller. Await journal
    // admission; its stable identity is retried and deduplicated by Home, so
    // native preparation need not await the delivery acknowledgement.
    await params.session.enqueueSessionEventCommitted({
      type: 'message',
      message: notice.items.map(item => `${item.name} couldn't start · ${item.detail ?? item.code}`).join('\n'),
      [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice,
    }, undefined, { awaitDelivery: false });
    if (operationContext && !await operationContext.isCurrent()) {
      throw new McpServerCatalogUnavailableError('scope-retired');
    }
  };
  let mcpSettings: ReturnType<typeof readMcpServersSettingsFromAccountSettings> | null = null;
  if (accountCredentials) {
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
  const detected = params.detectedMcpServers ?? daemonPluginPreparation?.detectedServers ?? (pluginRegistry?.discoverMcpServersForDetection && params.agentId
    ? (await detectProviderMcpServers({ directory: params.directory, providers: [params.agentId], env,
      runtimeRegistry: pluginRegistry })).servers : []);
  const nativeServerNames = readLoadedMcpNativeServerNames({ servers: detected, agentId: params.agentId });
  recordStartupPhase('native_discovery');
  let resolvedSelection: Awaited<ReturnType<typeof resolveSessionCapabilitiesForDirectory>> | null = null;
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
      agentAcceptsUserMcp: params.agentAcceptsUserMcp,
      sessionProject: projectInput,
      mcpPluginItems, nativeServerNames,
    }));
    resolvedSelection = initialSelection;
    recordStartupPhase('capability_selection');
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
        agentAcceptsUserMcp: params.agentAcceptsUserMcp,
        projectKey: initialSelection.projectKey,
        sessionProject: projectInput,
        mcpPluginItems, nativeServerNames,
      }));
      recordStartupPhase('capability_reselection');
    }
  }
  if (operationContext && !await operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
  recordStartupPhase('account_currentness');
  const emptyMcpServers: Record<string, McpServerConfig> = {};
  const builtIn = params.includeHappierMcpServer === false && !params.localTransport
    ? { happierMcpServer: { stop: async () => undefined, localContext: undefined, contextFilePath: undefined }, mcpServers: emptyMcpServers }
    : await createHappierMcpBridge(scopedSession, {
    ...(params.localTransport ? { localTransport: params.localTransport } : {}),
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
  });
  const ownedBridge = builtIn.happierMcpServer;
  const nativeContextFile = params.admittedStdio && builtIn.happierMcpServer.localContext
    ? join(params.admittedStdio.target.runtimeHome, SESSION_MCP_CONTEXT_RELATIVE_PATH) : undefined;
  const nativeBuiltInServers = nativeContextFile && builtIn.mcpServers.happier ? {
    ...builtIn.mcpServers, happier: { ...builtIn.mcpServers.happier,
      env: { ...builtIn.mcpServers.happier.env, [SESSION_MCP_CONTEXT_FILE_ENV]: nativeContextFile } },
  } : builtIn.mcpServers;
  const advertisedBuiltInMcpServers = params.includeHappierMcpServer === false ? emptyMcpServers : nativeBuiltInServers;
  const contextFile = nativeContextFile ?? builtIn.happierMcpServer.contextFilePath;
  const agentEnvironment = contextFile
    ? Object.freeze({ [SESSION_MCP_CONTEXT_FILE_ENV]: contextFile }) : undefined;
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
      get agentEnvironment() { return readAgentEnvironment(); },
      mcpServers: params.resolvedMcpServers ? mergeWithBuiltInHappierMcpServer({ builtIn: advertisedBuiltInMcpServers, extra: params.resolvedMcpServers }) : advertisedBuiltInMcpServers };
  }

  if (!mcpSettings || !resolvedSelection) {
    await disposePluginAttachments();
    recordStartupPhase('completed');
    return { ...naming, happierMcpServer: ownedBridge,
      get sessionMcpContext() { return builtIn.happierMcpServer.localContext; },
      get agentEnvironment() { return readAgentEnvironment(); },
      mcpServers: advertisedBuiltInMcpServers };
  }

  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(accountCredentials);
  const invocationSnapshot = operationContext?.readSnapshot();
  if (operationContext && !invocationSnapshot) {
    await ownedBridge.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  const sourceSignal = params.executionRun?.signal ?? params.session.getRuntimeLifetimeSignal?.() ?? undefined;
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
      resolvedSelection = { ...resolvedSelection, selectedServersByName: Object.fromEntries(attached.map(server => {
        const selectedServer = resolvedSelection!.selectedServersByName[server.name]!;
        return [server.name, server.transport.kind === 'http' || server.transport.kind === 'sse'
          ? { ...selectedServer, config: { ...selectedServer.config, remote: { ...selectedServer.config.remote!, url: server.transport.url } } }
          : selectedServer];
      })) };
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
  });
    recordStartupPhase('config_materialization');
  } catch (error) {
    await disposePluginAttachments();
    await retireRequestAuth();
    await ownedBridge.stop();
    throw error;
  }
  if (operationContext && !await operationContext.isCurrent()) {
    await disposePluginAttachments();
    materialized.cleanup();
    await retireRequestAuth();
    await ownedBridge.stop();
    throw new McpServerCatalogUnavailableError('scope-retired');
  }
  recordStartupPhase('account_currentness');

  if (materialized.warnings.length > 0) {
    logger.debug('[mcp] Materialization warnings', {
      warningCount: materialized.warnings.length,
      warnings: materialized.warnings.map((w) => ({ serverName: w.serverName, code: w.code, detail: w.detail,
        ...requestAuthDiagnosticsByServerId[resolvedSelection.itemsByName[w.serverName]?.serverId ?? ''] })),
    });
  }
  const identities = { mcpServerIdentities: Object.fromEntries(params.resolvedMcpServers ? [] : Object.keys(materialized.mcpServers).flatMap(name => {
    const item = resolvedSelection.itemsByName[name];
    const server = mcpSettings.servers.find(server => server.id === item?.serverId);
    const identity = resolvedSelection.mcpServerIdentities[name];
    if (!identity) return [];
    if (!server) return [[name, identity]];
    const binding = item?.bindingId ? mcpSettings.bindings.find(binding => binding.id === item.bindingId && binding.serverId === server.id) : undefined;
    const usage = binding?.enabled && mcpCatalog?.status === 'ready' && mcpCatalog.authority === 'active' && typeof mcpCatalog.revision === 'number'
      ? { serverId: server.id, bindingId: binding.id, serverRevision: server.updatedAt, bindingRevision: binding.updatedAt, catalogRevision: mcpCatalog.revision } : undefined;
    return [[name, { ...identity, ...(usage ? { usage } : {}) }]];
  })) as Record<string, McpServerIdentity> };
  const extra = params.resolvedMcpServers ?? materialized.mcpServers;
  const merged = mergeWithBuiltInHappierMcpServer({ builtIn: advertisedBuiltInMcpServers, extra });
  const warningsByName = new Map(materialized.warnings
    .filter(warning => !Object.hasOwn(merged, warning.serverName))
    .map(warning => [warning.serverName, warning]));
  if (warningsByName.size > 0) {
    try {
      await publishCapabilityNotice([...warningsByName.values()].map(warning => ({
        kind: 'mcp_server', name: warning.serverName,
        itemId: resolvedSelection.itemsByName[warning.serverName]?.serverId,
        code: warning.code, detail: warning.detail,
      })));
    } catch (error) {
      disposePluginAttachments();
      materialized.cleanup();
      retireRequestAuth();
      builtIn.happierMcpServer.stop();
      throw error;
    }
  }
  recordStartupPhase('capability_notice');

  const mcpServerIdentities = identities.mcpServerIdentities;
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
