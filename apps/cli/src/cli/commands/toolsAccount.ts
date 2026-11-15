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
  options?: Readonly<{ requireSessionId?: boolean }>): Promise<{
  credentials: StoredCredentials;
  sessionId: string | null;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
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
  const apiSource = accountAutomation ? await withHeldHome(async () => readMcpExecutionSource({
    credentials, catalogCredentials: credentials, machineId, serverHttpBaseUrl, localWorkflow,
    accountAutomation: { homeServerIdentityId: readServerIdentityIdFromFeaturesSnapshot(
      await api.getServerFeaturesSnapshot({ refresh: true })), isCurrent: isHomeCurrent },
  })) : null;
  const accountSettingsContext = await withHeldHome(() => loadFreshMcpAccountSettingsContext(credentials, deps));
  const customContext = await withHeldHome(() => deps.resolveCustomHappierToolsContext({
    credentials,
    accountSettingsSnapshot: accountSettingsContext,
    operationContext: accountSettingsContext.operationContext,
    machineId,
    directory,
    localWorkflow,
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
    accountSettings: accountSettingsContext.settings,
    operationContext: accountSettingsContext.operationContext,
    cleanup: customContext.cleanup,
    ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
  };
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
    const { tools: customTools, warnings } = await deps.listResolvedCustomHappierTools({ mcpServers: context.mcpServers });
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
    });
  } finally {
    context.cleanup();
  }
}
