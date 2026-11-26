import type { StoredCredentials } from '@/persistence';
import { readStoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { loadFreshMcpAccountSettingsContext } from './mcp/loadFreshMcpAccountSettingsContext';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { listBuiltInHappierTools, type BuiltInHappierToolsSurface } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { callBuiltInHappierTool } from '@/agent/tools/happierTools/callBuiltInHappierTool';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import { listResolvedCustomHappierTools } from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionId, ActionsSettingsV1, FeatureId } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readMcpExecutionSource, refuseMcpExecutionSource } from '@/mcp/runtime/mcpExecutionSource';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionToolsSearchInputV1Schema, SessionToolsDescribeInputV1Schema,
  SessionToolsCallInputV1Schema, SessionToolsCallOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionTools';
import type { ScriptToolConnection } from './toolsRun';

type BuiltInToolEntry = Awaited<ReturnType<typeof listBuiltInHappierTools>>[number];
type CustomToolEntry = Awaited<ReturnType<typeof listResolvedCustomHappierTools>>['tools'][number];
export type AccountToolCallResult = Awaited<ReturnType<typeof callBuiltInHappierTool>>
  | Awaited<ReturnType<typeof callResolvedCustomHappierTool>>;

export type ToolsCommandDeps = Readonly<{
  readCredentials: () => Promise<StoredCredentials | null>;
  initializeBackendApiContext: typeof initializeBackendApiContext;
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  listBuiltInHappierTools: (
    params: Readonly<{
      surface: BuiltInHappierToolsSurface;
      isActionEnabled: (id: ActionId) => boolean;
      isServerFeatureEnabled?: (id: FeatureId) => boolean;
      actionsSettings: ActionsSettingsV1;
    }>,
  ) => Promise<ReadonlyArray<BuiltInToolEntry>> | ReadonlyArray<BuiltInToolEntry>;
  callBuiltInHappierTool: typeof callBuiltInHappierTool;
  resolveCustomHappierToolsContext: typeof resolveCustomHappierToolsContext;
  listResolvedCustomHappierTools: typeof listResolvedCustomHappierTools;
  callResolvedCustomHappierTool: typeof callResolvedCustomHappierTool;
}>;

function resolveToolsCommandDeps(overrides?: Partial<ToolsCommandDeps>): ToolsCommandDeps {
  return {
    readCredentials: readStoredCredentials,
    initializeBackendApiContext,
    bootstrapAccountSettingsContext,
    listBuiltInHappierTools: async ({ surface, isActionEnabled, isServerFeatureEnabled, actionsSettings }) => {
      const catalog = await readDaemonPluginCatalog({ selection: 'tools' }).catch(() => ({
        kind: 'unavailable' as const,
        code: 'daemon_unavailable',
      }));
      return listBuiltInHappierTools({
        surface,
        isActionEnabled,
        ...(isServerFeatureEnabled ? { isServerFeatureEnabled } : {}),
        actionsSettings,
        pluginToolCatalog: catalog.kind === 'available' ? catalog.tools : Object.freeze([]),
      });
    },
    callBuiltInHappierTool,
    resolveCustomHappierToolsContext,
    listResolvedCustomHappierTools,
    callResolvedCustomHappierTool,
    ...overrides,
  };
}

type ToolsRequestContext = Readonly<{
  sessionId: string | null;
  directory: string;
  surface: BuiltInHappierToolsSurface;
  json: boolean;
}>;

async function resolveToolsBaseContext(
  request: ToolsRequestContext,
  deps: ToolsCommandDeps,
): Promise<{ credentials: StoredCredentials; sessionId: string | null; directory: string }> {
  const credentials = await deps.readCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "happier auth login" first.');
  return { credentials, sessionId: request.sessionId, directory: request.directory };
}

async function resolveCustomToolsRuntimeContext(request: ToolsRequestContext, deps: ToolsCommandDeps,
  options?: Readonly<{ requireSessionId?: boolean; signal?: AbortSignal;
    readCodeMode?: (features: CliServerFeaturesSnapshot | undefined) => void }>): Promise<{
  credentials: StoredCredentials;
  sessionId: string | null;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
  sessionConnections?: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['sessionConnections'];
  settingsByName?: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['settingsByName'];
  prepareTransport?: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['prepareTransport'];
  accountSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'];
  operationContext: SavedSecretOperationContextV1;
  cleanup: () => void;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}> {
  const { credentials, sessionId, directory } = await resolveToolsBaseContext(request, deps);
  if (options?.requireSessionId && !sessionId) throw new Error('Missing required flag: --session-id');
  const localWorkflow = request.surface === 'cli';
  const accountAutomation = localWorkflow && credentials.credentialProvenance === 'api_token'
    && !('requesterSessionCredentialScope' in credentials);
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const serverId = configuration.activeServerId;
  const isHomeCurrent = () => configuration.activeServerId === serverId;
  const withHeldHome = <T>(read: () => T): T => accountAutomation
    ? runWithServerHttpBaseUrl(serverHttpBaseUrl, read) : read();
  if (!accountAutomation) await readMcpExecutionSource({ credentials, localWorkflow });
  const { api, machineId } = await withHeldHome(() => deps.initializeBackendApiContext({
    credentials,
    machineMetadata: initialMachineMetadata,
    ...(request.json ? { suppressMachineRegistrationRecoveryLogs: true } : {}),
  }));
  let serverFeatures: CliServerFeaturesSnapshot | undefined;
  let apiSource: Awaited<ReturnType<typeof readMcpExecutionSource>> | null = null;
  let accountSettingsContext: Awaited<ReturnType<typeof loadFreshMcpAccountSettingsContext>>;
  if (accountAutomation) {
    serverFeatures = await withHeldHome(() => api.getServerFeaturesSnapshot({ refresh: true, signal: options?.signal }));
    options?.readCodeMode?.(serverFeatures);
    [apiSource, accountSettingsContext] = await Promise.all([
      withHeldHome(async () => readMcpExecutionSource({
        credentials, catalogCredentials: credentials, machineId, serverHttpBaseUrl, localWorkflow,
        accountAutomation: { homeServerIdentityId: readServerIdentityIdFromFeaturesSnapshot(serverFeatures), isCurrent: isHomeCurrent },
      })),
      withHeldHome(() => loadFreshMcpAccountSettingsContext(credentials, deps)),
    ]);
  } else if (options?.readCodeMode) {
    [serverFeatures, accountSettingsContext] = await Promise.all([
      withHeldHome(() => api.getServerFeaturesSnapshot({ refresh: true, signal: options?.signal })),
      withHeldHome(() => loadFreshMcpAccountSettingsContext(credentials, deps)),
    ]);
    options.readCodeMode(serverFeatures);
  } else {
    accountSettingsContext = await withHeldHome(() => loadFreshMcpAccountSettingsContext(credentials, deps));
  }
  const customContext = await withHeldHome(() => deps.resolveCustomHappierToolsContext({
    credentials,
    accountSettingsSnapshot: accountSettingsContext,
    operationContext: accountSettingsContext.operationContext,
    machineId,
    directory,
    localWorkflow,
    signal: options?.signal,
    ...(apiSource ? { readExecutionSource: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (!isHomeCurrent() || !await accountSettingsContext.operationContext.isCurrent()) {
        return refuseMcpExecutionSource('requester_authority_unavailable');
      }
      return apiSource;
    } } : {}),
  }));
  const serverFeaturesSnapshot = request.surface === 'agent' && sessionId
    ? await api.getServerFeaturesSnapshot({ refresh: true }).catch(() => undefined)
    : undefined;
  return {
    credentials,
    sessionId,
    directory,
    mcpServers: customContext.mcpServers,
    sessionConnections: customContext.sessionConnections,
    settingsByName: customContext.settingsByName,
    prepareTransport: customContext.prepareTransport,
    accountSettings: accountSettingsContext.settings,
    operationContext: accountSettingsContext.operationContext,
    cleanup: customContext.cleanup,
    ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
  };
}

/** The human CLI keeps its Account authority and reuses the existing CLI Action harness. */
export async function connectAccountToolScript(request: Omit<ToolsRequestContext, 'surface'>, signal: AbortSignal,
  overrides?: Partial<ToolsCommandDeps>): Promise<ScriptToolConnection> {
  const deps = resolveToolsCommandDeps(overrides);
  const [
    { refuseToolsScript }, { openCliHappierToolActionHarness }, { resolveSessionTransportContext },
    { createSessionCustomMcpClientPool }, { createSessionMcpCustomToolsBridge }, { bindSessionToolActions }, { SESSION_TOOL_OPERATION_IDS },
  ] = await Promise.all([
    import('./toolsRun'), import('@/agent/tools/happierTools/callBuiltInHappierTool'), import('@/session/services/resolveSessionTransportContext'),
    import('@/agent/tools/happierTools/customMcp/sessionCustomMcpClientPool'), import('@/mcp/runtime/sessionMcpToolsBridge'),
    import('@/mcp/runtime/sessionToolActions'), import('./toolsSessionMcp'),
  ]);
  if (!request.sessionId) return refuseToolsScript('invalid_arguments', 'Pass --session-id to select a Session.');
  const context = await resolveCustomToolsRuntimeContext({ ...request, surface: 'cli' }, deps, { signal, readCodeMode(snapshot) {
    if (snapshot?.status !== 'ready' || readServerEnabledBit(snapshot.features, 'sessions.codeMode') !== true) {
      refuseToolsScript('feature_disabled', 'Script runner is disabled for this Home.');
    }
  } });
  const pool = createSessionCustomMcpClientPool({ processEnv: process.env, prepareTransport: context.prepareTransport,
    isCurrent: context.operationContext.isCurrent, signal });
  const close = async () => { try { await pool.dispose(); } finally { context.cleanup(); } };
  try {
    const target = await resolveSessionTransportContext({ reason: 'session-action', credentials: context.credentials,
      idOrPrefix: request.sessionId, signal });
    if (!target.ok) return refuseToolsScript(target.code, target.code);
    const harness = await openCliHappierToolActionHarness({ credentials: context.credentials, rawSession: target.rawSession,
      readCredentials: deps.readCredentials });
    if (!harness.ok) return refuseToolsScript(harness.errorCode, harness.error);
    const servers = new Map(Object.entries(context.mcpServers).filter(([source]) => source !== 'happier')
      .map(([source, config]) => [source, {
        id: source, source,
        connection: context.sessionConnections?.[source] ?? { kind: 'stdio' as const, config },
        settings: context.settingsByName?.[source],
      }]));
    const actions = bindSessionToolActions({ sessionId: target.sessionId, execute: harness.actionToolBridge.executeActionByToolName,
      bridge: createSessionMcpCustomToolsBridge({ pool, readServers: () => servers,
        isConfined: () => false, authorize: async () => ({ ok: true }) }),
    });
    return { close, execute: async (operation, input, activeSignal) => {
      if (!harness.actionToolBridge.isActionEnabled(SESSION_TOOL_OPERATION_IDS[operation])) {
        return { ok: false, errorCode: 'action_disabled', error: 'Action is disabled.' };
      }
      try {
        const ctx = { signal: activeSignal, surface: 'cli' as const };
        if (operation === 'search') return { ok: true, result: await actions.sessionToolsSearch(SessionToolsSearchInputV1Schema.parse(input), ctx) };
        if (operation === 'describe') return { ok: true, result: await actions.sessionToolsDescribe(SessionToolsDescribeInputV1Schema.parse(input), ctx) };
        const result = SessionToolsCallOutputV1Schema.parse(await actions.sessionToolsCall(SessionToolsCallInputV1Schema.parse(input), ctx));
        return result.ok ? result : { ok: false, error: result.errorCode, errorCode: result.errorCode, failureCause: result.refusalCause };
      } catch (error) {
        const failure = ActionExecuteFailureSchema.safeParse(error);
        if (failure.success) return failure.data;
        return { ok: false, errorCode: 'tool_failed', error: error instanceof Error ? error.message : 'Tool failed.' };
      }
    } };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export async function listAccountTools(request: ToolsRequestContext, overrides?: Partial<ToolsCommandDeps>): Promise<Readonly<{
  builtInTools: ReadonlyArray<BuiltInToolEntry>;
  customTools: ReadonlyArray<CustomToolEntry>;
  warnings: Awaited<ReturnType<typeof listResolvedCustomHappierTools>>['warnings'];
}>> {
  if (request.surface === 'agent') refuseMcpExecutionSource('session_requester_unavailable');
  const deps = resolveToolsCommandDeps(overrides);
  const context = await resolveCustomToolsRuntimeContext(request, deps);
  try {
    const actionsSettingsProvider = createActionSettingsProvider({
      accountSettings: context.accountSettings,
      scopeKey: resolveAccountSettingsScopeKeyForToken(context.credentials.token),
    });
    const actionsSettings = actionsSettingsProvider.getActionsSettings();
    const builtInTools = await deps.listBuiltInHappierTools({
      surface: request.surface,
      actionsSettings,
      isActionEnabled: (id) => isActionEnabledByActionsSettings(id, actionsSettings, { surface: request.surface }),
    });
    const { tools: customTools, warnings } = await deps.listResolvedCustomHappierTools({ mcpServers: context.mcpServers,
      ...(context.settingsByName ? { settingsByName: context.settingsByName } : {}),
      ...(context.prepareTransport ? { prepareTransport: context.prepareTransport } : {}),
    });
    if (!await context.operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');
    return { builtInTools, customTools, warnings };
  } finally {
    context.cleanup();
  }
}

export async function callAccountTool(request: ToolsRequestContext & Readonly<{
  source: string;
  toolName: string;
  args: unknown;
  toolCallId: string | null;
  signal?: AbortSignal;
}>, overrides?: Partial<ToolsCommandDeps>): Promise<AccountToolCallResult> {
  const deps = resolveToolsCommandDeps(overrides);
  if (request.source === 'happier') {
    const context = await resolveToolsBaseContext(request, deps);
    if (!context.sessionId) throw new Error('Missing required flag: --session-id');
    return await deps.callBuiltInHappierTool({
      credentials: context.credentials,
      sessionId: context.sessionId,
      toolName: request.toolName,
      args: request.args,
      surface: request.surface,
      ...(request.surface === 'agent' && request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      readCredentials: deps.readCredentials,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }
  if (request.surface === 'agent') refuseMcpExecutionSource('session_requester_unavailable');
  const context = await resolveCustomToolsRuntimeContext(request, deps, { requireSessionId: true });
  try {
    return await deps.callResolvedCustomHappierTool({
      source: request.source,
      toolName: request.toolName,
      args: request.args,
      mcpServers: context.mcpServers,
      operationContext: context.operationContext,
      ...(context.settingsByName?.[request.source]?.tools ? { policy: context.settingsByName[request.source].tools } : {}),
      ...(context.prepareTransport ? { prepareTransport: context.prepareTransport } : {}),
    });
  } finally {
    context.cleanup();
  }
}
