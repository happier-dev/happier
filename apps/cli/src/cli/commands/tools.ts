import chalk from 'chalk';
import { TOOLS_USAGE } from './toolsHelp';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import type { ToolsCommandDeps, AccountToolCallResult, listAccountTools } from './toolsAccount';
import { fail } from '@happier-dev/cli-common/output';
import { resolveShellBridgeActionSurfaceV1 as resolveToolsCommandSurface } from '@/cli/actions/shellBridgeActionSurface';
import { callSessionMcpTool, listSessionMcpTools } from './toolsSessionMcp';
import { supportsSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalContext';
import { projectActionFailureForAgentV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
export type { ToolsCommandDeps } from './toolsAccount';

type AccountToolsListing = Awaited<ReturnType<typeof listAccountTools>>;
type CustomToolEntry = AccountToolsListing['customTools'][number];
type ToolCallResult = AccountToolCallResult | Awaited<ReturnType<typeof callSessionMcpTool>>;

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

function printHumanToolList(params: Readonly<{
  builtInTools: ReadonlyArray<Readonly<{ name: string; description?: string }>>;
  customTools: ReadonlyArray<CustomToolEntry>;
  warnings: ReadonlyArray<Readonly<{ source: string; error: string }>>;
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

      const { listAccountTools } = await import('./toolsAccount');
      const { builtInTools, customTools, warnings } = await listAccountTools({
        sessionId: getFlagValue(args, '--session-id'),
        directory: getFlagValue(args, '--directory') ?? process.cwd(),
        surface,
        json,
      }, overrides);
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
      } else {
        const { callAccountTool } = await import('./toolsAccount');
        result = await callAccountTool({
          sessionId: getFlagValue(args, '--session-id'),
          directory: getFlagValue(args, '--directory') ?? process.cwd(),
          surface,
          json,
          source,
          toolName,
          args: parsedArgs,
          toolCallId: getFlagValue(args, '--tool-call-id'),
          ...(signal ? { signal } : {}),
        }, overrides);
      }

      if (source === 'happier' && !result.ok) result = { ...result, ...projectActionFailureForAgentV1(result) };

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
