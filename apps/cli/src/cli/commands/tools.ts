import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { Credentials } from '@/persistence';
import { readCredentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { initializeBackendApiContext } from '@/agent/runtime/initializeBackendApiContext';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { callBuiltInHappierTool } from '@/agent/tools/happierTools/callBuiltInHappierTool';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import {
  listResolvedCustomHappierTools,
  type ResolvedCustomHappierToolWarning,
} from '@/agent/tools/happierTools/customMcp/listResolvedCustomHappierTools';
import { callResolvedCustomHappierTool } from '@/agent/tools/happierTools/customMcp/callResolvedCustomHappierTool';

type BuiltInToolEntry = Awaited<ReturnType<typeof listBuiltInHappierTools>>[number];
type CustomToolEntry = Awaited<ReturnType<typeof listResolvedCustomHappierTools>>['tools'][number];

export type ToolsCommandDeps = Readonly<{
  readCredentials: () => Promise<Credentials | null>;
  initializeBackendApiContext: typeof initializeBackendApiContext;
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  listBuiltInHappierTools: () => Promise<ReadonlyArray<BuiltInToolEntry>> | ReadonlyArray<BuiltInToolEntry>;
  callBuiltInHappierTool: typeof callBuiltInHappierTool;
  resolveCustomHappierToolsContext: typeof resolveCustomHappierToolsContext;
  listResolvedCustomHappierTools: typeof listResolvedCustomHappierTools;
  callResolvedCustomHappierTool: typeof callResolvedCustomHappierTool;
}>;

function resolveToolsCommandDeps(overrides?: Partial<ToolsCommandDeps>): ToolsCommandDeps {
  return {
    readCredentials,
    initializeBackendApiContext,
    bootstrapAccountSettingsContext,
    listBuiltInHappierTools: async () => listBuiltInHappierTools({ surface: 'cli' }),
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

function resolveCommandKind(args: readonly string[]): string {
  const subcommand = String(args[0] ?? '').trim();
  if (subcommand === 'list') return 'tools_list';
  if (subcommand === 'call') return 'tools_call';
  return subcommand ? `tools_${subcommand}` : 'tools_unknown';
}

async function resolveToolsRuntimeContext(args: readonly string[], deps: ToolsCommandDeps): Promise<{
  credentials: Credentials;
  sessionId: string | null;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
}>;

async function resolveToolsRuntimeContext(
  args: readonly string[],
  deps: ToolsCommandDeps,
  options: Readonly<{ requireSessionId: true }>,
): Promise<{
  credentials: Credentials;
  sessionId: string;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
}>;

async function resolveToolsRuntimeContext(
  args: readonly string[],
  deps: ToolsCommandDeps,
  options?: Readonly<{ requireSessionId?: boolean }>,
): Promise<{
  credentials: Credentials;
  sessionId: string | null;
  directory: string;
  mcpServers: Awaited<ReturnType<typeof resolveCustomHappierToolsContext>>['mcpServers'];
}> {
  const credentials = await deps.readCredentials();
  if (!credentials) throw new Error('Not authenticated. Run "happier auth login" first.');

  const sessionId = options?.requireSessionId === true
    ? requireFlagValue(args, '--session-id')
    : getFlagValue(args, '--session-id');
  const directory = getFlagValue(args, '--directory') ?? process.cwd();
  const { machineId } = await deps.initializeBackendApiContext({
    credentials,
    machineMetadata: initialMachineMetadata,
    ...(wantsJson(args) ? { suppressMachineRegistrationRecoveryLogs: true } : {}),
  });
  const accountSettingsContext = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
  });
  const customContext = await deps.resolveCustomHappierToolsContext({
    credentials,
    accountSettings: accountSettingsContext.settings ?? {},
    machineId,
    directory,
  });

  return { credentials, sessionId, directory, mcpServers: customContext.mcpServers };
}

function printHumanToolList(params: Readonly<{
  builtInTools: ReadonlyArray<BuiltInToolEntry>;
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

export async function handleToolsCommand(args: string[], overrides?: Partial<ToolsCommandDeps>): Promise<void> {
  const deps = resolveToolsCommandDeps(overrides);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);
  const subcommand = String(args[0] ?? '').trim();

  try {
    if (subcommand === 'list') {
      const context = await resolveToolsRuntimeContext(args, deps);
      const builtInTools = await deps.listBuiltInHappierTools();
      const { tools: customTools, warnings } = await deps.listResolvedCustomHappierTools({ mcpServers: context.mcpServers });

      if (json) {
        printJsonEnvelope({
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
    }

    if (subcommand === 'call') {
      const context = await resolveToolsRuntimeContext(args, deps, { requireSessionId: true });
      const source = requireFlagValue(args, '--source');
      const toolName = requireFlagValue(args, '--tool');
      const argsJson = requireFlagValue(args, '--args-json');
      const parsedArgs = JSON.parse(argsJson);

      const result = source === 'happier'
        ? await deps.callBuiltInHappierTool({
            credentials: context.credentials,
            sessionId: context.sessionId,
            toolName,
            args: parsedArgs,
          })
        : await deps.callResolvedCustomHappierTool({
            source,
            toolName,
            args: parsedArgs,
            mcpServers: context.mcpServers,
          });

      if (json) {
        if (result.ok) {
          printJsonEnvelope({
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
          printJsonEnvelope({
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
      console.log(JSON.stringify(result.result, null, 2));
      return;
    }

    throw new Error('Usage: happier tools <list|call> ...');
  } catch (error) {
    if (!json) throw error;
    const mapped = mapUnknownErrorToControlError(error);
    printJsonEnvelope(
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
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);

  try {
    await handleToolsCommand(args);
  } catch (error) {
    if (json) {
      const mapped = mapUnknownErrorToControlError(error);
      printJsonEnvelope(
        {
          ok: false,
          kind,
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }

    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
