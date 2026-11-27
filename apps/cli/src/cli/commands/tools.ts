import chalk from 'chalk';
import { TOOLS_USAGE } from './toolsHelp';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import type { ToolsCommandDeps, AccountToolCallResult, listAccountTools } from './toolsAccount';
import { fail } from '@happier-dev/cli-common/output';
import { resolveShellBridgeActionSurfaceV1 as resolveToolsCommandSurface } from '@/cli/actions/shellBridgeActionSurface';
import { callSessionMcpToolByTarget, callSessionToolOperation, connectSessionToolScript, hasSessionMcpContext,
  listSessionMcpTools } from './toolsSessionMcp';
import { supportsSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalContext';
import { logger } from '@/ui/logger';
import { projectActionFailureForAgentV1, readActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
export type { ToolsCommandDeps } from './toolsAccount';

type AccountToolsListing = Awaited<ReturnType<typeof listAccountTools>>;
type CustomToolEntry = AccountToolsListing['customTools'][number];
type ToolCallResult = AccountToolCallResult | Awaited<ReturnType<typeof callSessionMcpToolByTarget>>;

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
  const explicitSessionId = getFlagValue(args, '--session-id');
  const ambientSessionMcp = !explicitSessionId && hasSessionMcpContext() && supportsSessionMcpLocalTransport();
  const useSessionMcp = (surface === 'agent' && supportsSessionMcpLocalTransport()) || ambientSessionMcp;

  try {
    if (subcommand === 'run') {
      if (surface === 'agent' && !useSessionMcp) {
        process.exitCode = Math.max(process.exitCode ?? 0, 1);
        await writeJsonStdout({ ok: false, error: { code: 'session_requester_unavailable',
          message: 'Session tool transport is unavailable.' }, calls: [] });
        return;
      }
      const { runToolsScript, refuseToolsScript } = await import('./toolsRun');
      await runToolsScript({ argv: args.slice(1), signal, connect: async scriptSignal => {
        if (!useSessionMcp) {
          const { connectAccountToolScript } = await import('./toolsAccount');
          return connectAccountToolScript({ sessionId: explicitSessionId,
            directory: getFlagValue(args, '--directory') ?? process.cwd(), json }, scriptSignal, overrides);
        }
        const connection = await connectSessionToolScript(scriptSignal);
        if (!connection.ok) return refuseToolsScript(connection.errorCode, connection.error,
          'failureCause' in connection ? connection.failureCause : undefined);
        if (!connection.supported) {
          await connection.close().catch(() => logger.debug('[tools] Session connection cleanup failed'));
          return refuseToolsScript('feature_disabled', 'Script runner is disabled for this Session.');
        }
        return connection;
      } });
      return;
    }

    if (subcommand === 'search' || subcommand === 'describe' || (subcommand === 'list' && args.includes('--query'))) {
      const operation = subcommand === 'describe' ? 'describe' : 'search';
      const query = getFlagValue(args, '--query') ?? (args[1] && !args[1].startsWith('-') ? args[1] : null);
      const input = operation === 'search' ? (query ? { query } : {})
        : { source: requireFlagValue(args, '--source'), tool: requireFlagValue(args, '--tool') };
      const activeSignal = signal ?? new AbortController().signal;
      const result = await (async () => {
        if (useSessionMcp || (surface === 'agent' && hasSessionMcpContext())) return callSessionToolOperation(operation, input, signal);
        if (surface === 'agent') return { ok: false, errorCode: 'session_requester_unavailable', error: 'Session tool transport is unavailable.' } as const;
        const { connectAccountToolScript } = await import('./toolsAccount');
        const connection = await connectAccountToolScript({ sessionId: getFlagValue(args, '--session-id'),
          directory: getFlagValue(args, '--directory') ?? process.cwd(), json }, activeSignal, overrides);
        try { return await connection.execute(operation, input, activeSignal); }
        finally {
          try { await connection.close(); }
          catch { logger.debug('[tools] Account connection cleanup failed'); }
        }
      })();
      if (result.ok) {
        if (json) await printJsonEnvelope({ ok: true, kind, data: result.result });
        else await writeJsonStdout(result.result, { pretty: true });
      } else if (json) await printJsonEnvelope({ ok: false, kind, error: {
        code: result.errorCode, message: result.error,
        ...('failureCause' in result && result.failureCause ? { failureCause: result.failureCause } : {}),
      } }, { exitCode: 1 });
      else throw new Error(result.error);
      return;
    }

    if (subcommand === 'list') {
      if (useSessionMcp) {
        const listed = await listSessionMcpTools(signal);
        if (!listed.ok) {
          if (!json) throw new Error(listed.error);
          await printJsonEnvelope({ ok: false, kind, error: { code: listed.errorCode, message: listed.error,
            ...(listed.failureCause ? { failureCause: listed.failureCause } : {}) } }, { exitCode: 1 });
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
      const qualifiedAction = source === 'happier'
        && (ActionIdSchema.safeParse(toolName).success || Boolean(parseQualifiedPluginActionId(toolName)));

      let result: ToolCallResult;
      if (useSessionMcp) {
        const toolCallId = getFlagValue(args, '--tool-call-id');
        // Legacy exact shell commands use the stable named-tool binding.
        // Qualified Action IDs and configured MCP sources use Session dispatch.
        result = await callSessionMcpToolByTarget({ source, toolName, args: parsedArgs,
          ...(toolCallId ? { toolCallId } : {}), signal,
        }, source !== 'happier' || qualifiedAction);
      } else {
        const { callAccountTool } = await import('./toolsAccount');
        result = await callAccountTool({
          sessionId: getFlagValue(args, '--session-id'),
          directory: getFlagValue(args, '--directory') ?? process.cwd(),
          surface,
          json,
          source,
          toolName: surface === 'cli' && qualifiedAction ? 'action_execute' : toolName,
          args: surface === 'cli' && qualifiedAction ? { actionId: toolName, input: parsedArgs } : parsedArgs,
          toolCallId: getFlagValue(args, '--tool-call-id'),
          ...(signal ? { signal } : {}),
        }, overrides);
      }

      if (source === 'happier' && surface === 'agent' && !result.ok) {
        result = { ...result, ...projectActionFailureForAgentV1(result) };
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
          const presentation = source === 'happier'
            ? readActionFailurePresentationV1(result.errorCode, 'details' in result ? result.details : undefined)
            : null;
          await printJsonEnvelope({
            ok: false,
            kind,
            error: {
              code: result.errorCode,
              message: result.error,
              ...(source === 'happier' && surface === 'agent' && 'requestId' in result && typeof result.requestId === 'string'
                ? { requestId: result.requestId } : {}),
              ...(useSessionMcp && 'failureCause' in result && result.failureCause ? { failureCause: result.failureCause } : {}),
              ...(presentation ? { details: { message: presentation.message, messageTrust: presentation.messageTrust } } : {}),
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
