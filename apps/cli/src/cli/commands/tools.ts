import chalk from 'chalk';
import { TOOLS_USAGE } from './toolsHelp';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { StoredCredentials } from '@/persistence';
import { readStoredCredentials } from '@/persistence';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { loadFreshMcpAccountSettingsContext } from './mcp/loadFreshMcpAccountSettingsContext';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import {
  listBuiltInHappierTools,
  type BuiltInHappierToolsSurface,
} from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { callBuiltInHappierTool } from '@/agent/tools/happierTools/callBuiltInHappierTool';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import {
  listResolvedCustomHappierTools,
  type ResolvedCustomHappierToolWarning,
} from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionId, ActionsSettingsV1, FeatureId } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { fail } from '@happier-dev/cli-common/output';
import { resolveShellBridgeActionSurfaceV1 as resolveToolsCommandSurface } from '@/cli/actions/shellBridgeActionSurface';
import { callSessionMcpTool, listSessionMcpTools } from './toolsSessionMcp';
import { supportsSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readMcpExecutionSource, refuseMcpExecutionSource } from '@/mcp/runtime/mcpExecutionSource';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';

type BuiltInToolEntry = Awaited<ReturnType<typeof listBuiltInHappierTools>>[number];
type CustomToolEntry = Awaited<ReturnType<typeof listResolvedCustomHappierTools>>['tools'][number];
type ToolCallResult = Awaited<ReturnType<typeof callBuiltInHappierTool>>
  | Awaited<ReturnType<typeof callResolvedCustomHappierTool>>
  | Awaited<ReturnType<typeof callSessionMcpTool>>;

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

function getFlagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireFlagValue(args: readonly string[], flag: string): string {
  const value = getFlagValue(args, flag);
  if (!value) throw new Error(`Missing required flag: ${flag}`);
  return value;
}

/**
 * The provenance the host stamped on a generated shell-bridge command. A human
 * `happier tools` invocation never carries it, so this is the one place the two
 * origins separate — reading stored credentials proves the process can reach the
 * account, not that a person asked for the call.
 */

function resolveCommandKind(args: readonly string[]): string {
  const subcommand = String(args[0] ?? '').trim();
  if (subcommand === 'list') return 'tools_list';
  if (subcommand === 'call') return 'tools_call';
  return subcommand ? `tools_${subcommand}` : 'tools_unknown';
}

async function resolveToolsBaseContext(args: readonly string[], deps: ToolsCommandDeps): Promise<{
  credentials: StoredCredentials;
  sessionId: string | null;
  directory: string;
}>;

async function resolveToolsBaseContext(
  args: readonly string[],
  deps: ToolsCommandDeps,
  options: Readonly<{ requireSessionId: true }>,
): Promise<{
  credentials: StoredCredentials;
  sessionId: string;
  directory: string;
}>;

async function resolveToolsBaseContext(
  args: readonly string[],
  deps: ToolsCommandDeps,
  options?: Readonly<{ requireSessionId?: boolean }>,
): Promise<{
  credentials: StoredCredentials;
  sessionId: string | null;
  directory: string;
}> {
  const credentials = await deps.readCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "happier auth login" first.');

  const sessionId = options?.requireSessionId === true
    ? requireFlagValue(args, '--session-id')
    : getFlagValue(args, '--session-id');
  const directory = getFlagValue(args, '--directory') ?? process.cwd();

  return { credentials, sessionId, directory };
}

async function resolveCustomToolsRuntimeContext(args: readonly string[], deps: ToolsCommandDeps): Promise<{
  credentials: StoredCredentials;
  sessionId: string | null;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
  accountSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'];
  operationContext: SavedSecretOperationContextV1;
  cleanup: () => void;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>;

async function resolveCustomToolsRuntimeContext(
  args: readonly string[],
  deps: ToolsCommandDeps,
  options: Readonly<{ requireSessionId: true }>,
): Promise<{
  credentials: StoredCredentials;
  sessionId: string;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
  accountSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'];
  operationContext: SavedSecretOperationContextV1;
  cleanup: () => void;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>;

async function resolveCustomToolsRuntimeContext(
  args: readonly string[],
  deps: ToolsCommandDeps,
  options?: Readonly<{ requireSessionId?: boolean }>,
): Promise<{
  credentials: StoredCredentials;
  sessionId: string | null;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
  accountSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'];
  operationContext: SavedSecretOperationContextV1;
  cleanup: () => void;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}> {
  const baseContext = options?.requireSessionId === true
    ? await resolveToolsBaseContext(args, deps, { requireSessionId: true })
    : await resolveToolsBaseContext(args, deps);
  const { credentials, sessionId, directory } = baseContext;
  const localWorkflow = resolveToolsCommandSurface(args) === 'cli';
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
    ...(wantsJson(args) ? { suppressMachineRegistrationRecoveryLogs: true } : {}),
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
  const serverFeaturesSnapshot = resolveToolsCommandSurface(args) === 'agent' && sessionId
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

function printHumanToolList(params: Readonly<{
  builtInTools: ReadonlyArray<Readonly<{ name: string; description?: string }>>;
  customTools: ReadonlyArray<CustomToolEntry>;
  warnings: ReadonlyArray<ResolvedCustomHappierToolWarning>;
}>): void {
  console.log('happier');
  for (const tool of params.builtInTools) {
    console.log(`- ${tool.name}: ${tool.description}`);
  }
  const bySource = new Map<string, CustomToolEntry[]>();
  for (const tool of params.customTools) {
    const current = bySource.get(tool.source) ?? [];
    current.push(tool);
    bySource.set(tool.source, current);
  }
  for (const [source, tools] of bySource) {
    console.log(source);
    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description ?? ''}`.trimEnd());
    }
  }
  for (const warning of params.warnings) {
    console.error(chalk.yellow('Warning:'), `Unable to list tools from ${warning.source}: ${warning.error}`);
  }
}

export async function handleToolsCommand(args: string[], overrides?: Partial<ToolsCommandDeps>, signal?: AbortSignal): Promise<void> {
  const deps = resolveToolsCommandDeps(overrides);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);
  const subcommand = String(args[0] ?? '').trim();
  const surface = resolveToolsCommandSurface(args);
  const useSessionMcp = surface === 'agent' && supportsSessionMcpLocalTransport();

  try {
    if (subcommand === 'list') {
      if (useSessionMcp) {
        const listed = await listSessionMcpTools(signal);
        if (!listed.ok) {
          if (!json) throw new Error(listed.error);
          await printJsonEnvelope({ ok: false, kind, error: { code: listed.errorCode, message: listed.error } }, { exitCode: 1 });
          return;
        }
        if (json) await printJsonEnvelope({ ok: true, kind, data: { sources: listed.sources, warnings: listed.warnings } });
        else printHumanToolList({ builtInTools: listed.sources.happier ?? [],
          customTools: Object.entries(listed.sources).flatMap(([source, tools]) => source === 'happier' ? [] : tools.map(tool => ({ ...tool, source }))),
          warnings: listed.warnings });
        return;
      }
      if (surface === 'agent') refuseMcpExecutionSource('session_requester_unavailable');
      const context = await resolveCustomToolsRuntimeContext(args, deps);
      try {
        const actionsSettingsProvider = createActionSettingsProvider({
          accountSettings: context.accountSettings,
          scopeKey: resolveAccountSettingsScopeKeyForToken(context.credentials.token),
        });
        const actionsSettings = actionsSettingsProvider.getActionsSettings();
        const builtInTools = await deps.listBuiltInHappierTools({
          surface,
          actionsSettings,
          isActionEnabled: (id) => isActionEnabledByActionsSettings(id, actionsSettings, { surface }),
        });
        const { tools: customTools, warnings } = await deps.listResolvedCustomHappierTools({ mcpServers: context.mcpServers });
        if (!await context.operationContext.isCurrent()) throw new McpServerCatalogUnavailableError('scope-retired');

        if (json) {
          await printJsonEnvelope({
            ok: true,
            kind,
            data: {
              sources: {
                happier: builtInTools.map((tool) => ({
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
                ...Object.fromEntries(
                  Array.from(
                    customTools.reduce((map, tool) => {
                      const list = map.get(tool.source) ?? [];
                      list.push(tool);
                      map.set(tool.source, list);
                      return map;
                    }, new Map<string, CustomToolEntry[]>()),
                  ).map(([source, tools]) => [
                    source,
                    tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description ?? null,
                      inputSchema: tool.inputSchema ?? null,
                    })),
                  ]),
                ),
              },
              warnings,
            },
          });
          return;
        }

        printHumanToolList({ builtInTools, customTools, warnings });
        return;
      } finally {
        context.cleanup();
      }
    }

    if (subcommand === 'call') {
      const source = requireFlagValue(args, '--source');
      const toolName = requireFlagValue(args, '--tool');
      const argsJson = requireFlagValue(args, '--args-json');
      const parsedArgs = JSON.parse(argsJson);

      let result: ToolCallResult;
      if (useSessionMcp) {
        const toolCallId = getFlagValue(args, '--tool-call-id');
        result = await callSessionMcpTool({ source, toolName, args: parsedArgs,
          ...(toolCallId ? { toolCallId } : {}),
          ...(signal ? { signal } : {}),
        });
      } else if (source === 'happier') {
        const context = await resolveToolsBaseContext(args, deps, { requireSessionId: true });
        const toolCallId = surface === 'agent' ? getFlagValue(args, '--tool-call-id') : null;
        result = await deps.callBuiltInHappierTool({
          credentials: context.credentials,
          sessionId: context.sessionId,
          toolName,
          args: parsedArgs,
          surface,
          ...(toolCallId ? { toolCallId } : {}),
          readCredentials: deps.readCredentials,
          ...(signal ? { signal } : {}),
        });
      } else {
        if (surface === 'agent') refuseMcpExecutionSource('session_requester_unavailable');
        const context = await resolveCustomToolsRuntimeContext(args, deps, { requireSessionId: true });
        try {
          result = await deps.callResolvedCustomHappierTool({
            source,
            toolName,
            args: parsedArgs,
            mcpServers: context.mcpServers,
            operationContext: context.operationContext,
          });
        } finally {
          context.cleanup();
        }
      }

      if (json) {
        if (result.ok) {
          await printJsonEnvelope({
            ok: true,
            kind,
            data: {
              source,
              tool: toolName,
              isError: false,
              output: result.result,
            },
          }, { exitCode: 0 });
        } else {
          const candidates = 'candidates' in result && Array.isArray(result.candidates)
            ? result.candidates
            : undefined;
          await printJsonEnvelope({
            ok: false,
            kind,
            error: {
              code: result.errorCode,
              message: result.error,
              ...(candidates ? { candidates } : {}),
            },
          }, { exitCode: 1 });
        }
        return;
      }

      if (!result.ok) throw new Error(result.error);
      await writeJsonStdout(result.result, { pretty: true });
      return;
    }

    throw new Error(TOOLS_USAGE);
  } catch (error) {
    if (!json) throw error;
    const mapped = mapUnknownErrorToControlError(error);
    await printJsonEnvelope(
      {
        ok: false,
        kind,
        error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
      },
      { exitCode: mapped.unexpected ? 2 : 1 },
    );
  }
}

export async function handleToolsCliCommand(context: CommandContext): Promise<void> {
  if (context.args.includes('--help') || context.args.includes('-h')) { console.log(TOOLS_USAGE); return; }
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);

  try {
    await handleToolsCommand(args, undefined, context.signal);
  } catch (error) {
    if (json) {
      const mapped = mapUnknownErrorToControlError(error);
      await printJsonEnvelope(
        {
          ok: false,
          kind,
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }

    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
