import { errorFrame, ok } from '@happier-dev/cli-common/output';

import { configuration } from '@/configuration';
import { requestDaemonPluginActionExecution } from '@/daemon/controlClient';
import { ensureDaemonRunningForSessionCommand } from '@/daemon/ensureDaemon';
import type { CommandContext } from './commandRegistry';
import { printJsonEnvelope } from './output/jsonEnvelope';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
  resolvePluginCommandProjection,
  type PluginCommandProjection,
} from './pluginCommandProjection';
import {
  normalizePluginCommandActionInputTokens,
  resolvePluginCommandActionInputContract,
} from './pluginCommandFields';
import type { ActionCliField } from '@/cli/actions/compiledCommands';
import { listActionCliCommandFlags, parseActionCliInput } from '@/cli/actions/parseCommandInput';
import { buildFieldOptionRows } from '@/cli/actions/commandHelp';

export type PluginCommandExecutionResult = Readonly<
  | {
    ok: true;
    qualifiedCommandId: string;
    qualifiedActionId: string;
    result: unknown;
  }
  | {
    ok: false;
    code: string;
    message: string;
    qualifiedCommandId?: string;
    qualifiedActionId?: string;
  }
>;

/** The command path words, which always precede any option token. */
function readPluginCommandPath(args: readonly string[]): readonly string[] {
  const path: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) break;
    path.push(token);
  }
  return Object.freeze(path);
}

/**
 * Ordinary field flags for a plugin command whose canonical contributed Action
 * definition is discoverable, parsed by the same compiler a first-party
 * command uses. `--input` remains an accepted spelling of `--input-json` for
 * installed callers.
 */
function parseCompiledPluginCommandInput(params: Readonly<{
  fields: readonly ActionCliField[];
  args: readonly string[];
  pathLength: number;
}>): Readonly<{ ok: true; input: unknown } | { ok: false; message: string }> {
  const tokens = normalizePluginCommandActionInputTokens(params.args.slice(params.pathLength));
  const parsed = parseActionCliInput({ fields: params.fields, positionals: [] }, tokens);
  return parsed.ok
    ? { ok: true, input: Object.freeze({ ...(parsed.canonicalBase ?? {}), ...parsed.callerOverlay }) }
    : { ok: false, message: parsed.message };
}

function parseInvocationArgs(args: readonly string[]): Readonly<
  | { ok: true; path: readonly string[]; input: unknown }
  | { ok: false; message: string }
> {
  const path: string[] = [];
  let input: unknown = {};
  let hasInput = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--json') continue;
    if (token === '--input') {
      if (hasInput) return { ok: false, message: 'Plugin commands accept --input exactly once' };
      const raw = args[index + 1];
      if (raw === undefined) return { ok: false, message: '--input requires a JSON value' };
      try {
        input = JSON.parse(raw) as unknown;
      } catch {
        return { ok: false, message: 'Invalid --input JSON' };
      }
      hasInput = true;
      index += 1;
      continue;
    }
    if (token.startsWith('--input=')) {
      if (hasInput) return { ok: false, message: 'Plugin commands accept --input exactly once' };
      try {
        input = JSON.parse(token.slice('--input='.length)) as unknown;
      } catch {
        return { ok: false, message: 'Invalid --input JSON' };
      }
      hasInput = true;
      continue;
    }
    if (token.startsWith('-')) {
      return { ok: false, message: 'Unknown plugin command option' };
    }
    path.push(token);
  }

  return { ok: true, path: Object.freeze(path), input };
}

function findCommandContribution(
  registry: ResolvedContributionRegistry,
  qualifiedId: string,
): ResolvedCommandContribution | null {
  return (registry.commands ?? []).find((candidate) => (
    candidate.pluginId
    && `${candidate.pluginId}/${candidate.definition.id}` === qualifiedId
  )) ?? null;
}

function validateCommandArguments(command: ResolvedCommandContribution, input: unknown): boolean {
  const schema = command.definition.arguments;
  if (!schema) return true;
  return validatePluginCommandInput(schema, input);
}

function validatePluginCommandInput(
  schema: Parameters<typeof compilePluginJsonSchema>[0],
  input: unknown,
): boolean {
  try {
    return isValidPluginJsonSchemaValue(compilePluginJsonSchema(schema), input);
  } catch {
    return false;
  }
}

function hasPluginCliFlagBeforeTerminator(args: readonly string[], flags: ReadonlySet<string>): boolean {
  for (const token of args) {
    if (token === '--') return false;
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (flags.has(name)) return true;
  }
  return false;
}

function wantsPluginCommandJson(args: readonly string[]): boolean {
  return hasPluginCliFlagBeforeTerminator(args, new Set(['--json']));
}

type ResolvedPluginCommandInvocation = Readonly<{
  qualifiedCommandId: string;
  qualifiedActionId: string;
  input: unknown;
}>;

function resolvePluginCommandInvocation(params: Readonly<{
  registry: ResolvedContributionRegistry;
  root: string;
  args: readonly string[];
  reservedRoots?: ReadonlySet<string>;
}>): ResolvedPluginCommandInvocation | Extract<PluginCommandExecutionResult, { ok: false }> {
  // The path is resolved first, because which command was named decides which
  // canonical Action definition owns the remaining tokens.
  const path = readPluginCommandPath(params.args);
  if (path[0] !== params.root) {
    return { ok: false, code: 'plugin_command_unknown', message: `Unknown plugin command: ${path.join(' ')}` };
  }

  const projection = resolvePluginCommandProjection({
    registry: params.registry,
    reservedRoots: params.reservedRoots ?? new Set(),
  });
  const matches = projection.commands.filter((command) => (
    command.path.length === path.length
    && command.path.every((segment, index) => segment === path[index])
  ));
  if (matches.length === 0) {
    return { ok: false, code: 'plugin_command_unknown', message: `Unknown plugin command: ${path.join(' ')}` };
  }
  if (matches.length !== 1 || matches[0]!.status === 'ambiguous') {
    return { ok: false, code: 'plugin_command_path_ambiguous', message: `Ambiguous plugin command: ${path.join(' ')}` };
  }

  const matched = matches[0]!;
  if (matched.status === 'unavailable') {
    return {
      ok: false,
      code: matched.unavailableCode ?? 'plugin_command_unavailable',
      message: `Plugin command is unavailable: ${matched.qualifiedId}`,
      qualifiedCommandId: matched.qualifiedId,
      qualifiedActionId: matched.qualifiedActionId,
    };
  }
  const contribution = findCommandContribution(params.registry, matched.qualifiedId);
  if (!contribution) {
    return { ok: false, code: 'plugin_command_generation_retired', message: 'Plugin command generation is no longer current' };
  }
  // A contribution whose canonical Action definition is discoverable uses the
  // one shared field parser; a predecessor shape without one keeps the bounded
  // JSON-only adapter rather than weakening every command to its limits.
  const actionInput = resolvePluginCommandActionInputContract({
    registry: params.registry,
    qualifiedActionId: matched.qualifiedActionId,
  });
  if (actionInput?.flagCollision) {
    return {
      ok: false,
      code: actionInput.flagCollision.code,
      message: `Plugin Action input field ${actionInput.flagCollision.fieldPath} collides with CLI flag ${actionInput.flagCollision.flag}`,
      qualifiedCommandId: matched.qualifiedId,
      qualifiedActionId: matched.qualifiedActionId,
    };
  }
  const parsed = actionInput
    ? parseCompiledPluginCommandInput({ fields: actionInput.fields, args: params.args, pathLength: path.length })
    : parseInvocationArgs(params.args);
  if (!parsed.ok) {
    return { ok: false, code: 'plugin_command_arguments_invalid', message: parsed.message };
  }
  const inputIsValid = actionInput
    ? validatePluginCommandInput(actionInput.inputSchema, parsed.input)
    : validateCommandArguments(contribution, parsed.input);
  if (!inputIsValid) {
    return {
      ok: false,
      code: 'plugin_command_arguments_invalid',
      message: actionInput
        ? 'Plugin command input does not match its canonical Action schema'
        : 'Plugin command input does not match its manifest arguments schema',
      qualifiedCommandId: matched.qualifiedId,
      qualifiedActionId: matched.qualifiedActionId,
    };
  }
  return {
    qualifiedCommandId: matched.qualifiedId,
    qualifiedActionId: matched.qualifiedActionId,
    input: parsed.input,
  };
}

async function printPluginCommandFailure(
  args: readonly string[],
  failure: Extract<PluginCommandExecutionResult, { ok: false }>,
): Promise<void> {
  if (wantsPluginCommandJson(args)) {
    await printJsonEnvelope({
      ok: false,
      kind: 'plugin_command',
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.qualifiedCommandId ? { commandId: failure.qualifiedCommandId } : {}),
        ...(failure.qualifiedActionId ? { actionId: failure.qualifiedActionId } : {}),
      },
    }, { exitCode: 1 });
    return;
  }
  console.error(errorFrame(failure.message));
  process.exitCode = 1;
}

function renderPluginCommandHelp(params: Readonly<{
  projection: PluginCommandProjection;
  root: string;
  args: readonly string[];
  registry: ResolvedContributionRegistry;
}>): string {
  const requestedPath = readPluginCommandPath(params.args);
  const exact = params.projection.commands.find((command) => (
    command.path.length === requestedPath.length
    && command.path.every((segment, index) => segment === requestedPath[index])
  ));
  if (exact) {
    // Help reads the same derivation the parser does, so a documented flag is
    // always an accepted one.
    const actionInput = resolvePluginCommandActionInputContract({
      registry: params.registry,
      qualifiedActionId: exact.qualifiedActionId,
    });
    const documentedFields = actionInput && !actionInput.flagCollision ? actionInput.fields : [];
    const fieldUsage = documentedFields.length > 0
      ? `${listActionCliCommandFlags({ fields: documentedFields, positionals: [] }).map((flag) => `[${flag}]`).join(' ')} `
      : '';
    return [
      `${exact.title}`,
      exact.description ?? '',
      '',
      `Usage: happier ${exact.path.join(' ')} ${fieldUsage}[--input-json <json>] [--json]`,
      'Alias: --input <json>',
      ...(documentedFields.length > 0
        ? ['', 'Options:', ...buildFieldOptionRows(documentedFields).map((row) => `  ${row.label}  ${row.description}`), '']
        : []),
      `Command: ${exact.qualifiedId}`,
      `Action: ${exact.qualifiedActionId}`,
      ...(exact.status === 'available'
        ? actionInput?.flagCollision
          ? [`Unavailable: ${actionInput.flagCollision.code}`]
          : []
        : [`Unavailable: ${exact.unavailableCode ?? 'plugin_command_unavailable'}`]),
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== '')).join('\n');
  }

  const commands = params.projection.commands.filter((command) => (
    command.path[0] === params.root
    && command.status === 'available'
    && command.visibility === 'default'
  ));
  return [
    `Usage: happier ${params.root} <command> [--input-json <json>] [--json]`,
    'Alias: --input <json>',
    '',
    ...commands.map((command) => `  ${command.path.slice(1).join(' ')}  ${command.description ?? command.title}`),
  ].join('\n');
}

export async function handlePluginCommandCliCommand(
  root: string,
  context: CommandContext,
): Promise<void> {
  const registryResult = await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir })
    .then((registry) => Object.freeze({ ok: true as const, registry }))
    .catch(() => Object.freeze({ ok: false as const }));
  if (!registryResult.ok) {
    await printPluginCommandFailure(context.args, {
      ok: false,
      code: 'plugin_command_registry_unavailable',
      message: 'Plugin command registry is unavailable',
    });
    return;
  }
  const { registry } = registryResult;
  const projection = resolvePluginCommandProjection({
    registry,
    reservedRoots: new Set(),
  });
  const hasRootCommand = projection.commands.some((command) => (
    command.path.length === 1 && command.path[0] === root
  ));
  const asksForHelp = (context.args.length === 1 && !hasRootCommand)
    || hasPluginCliFlagBeforeTerminator(context.args, new Set(['--help', '-h']));
  if (asksForHelp) {
    const text = renderPluginCommandHelp({ projection, root, args: context.args, registry });
    if (wantsPluginCommandJson(context.args)) {
      await printJsonEnvelope({
        ok: true,
        kind: 'plugin_command_help',
        data: { root, text },
      });
    } else {
      console.log(text);
    }
    return;
  }

  const invocation = resolvePluginCommandInvocation({
    registry,
    root,
    args: context.args,
  });
  if ('ok' in invocation) {
    await printPluginCommandFailure(context.args, invocation);
    return;
  }
  await ensureDaemonRunningForSessionCommand();
  const attempt = await requestDaemonPluginActionExecution({
    actionId: invocation.qualifiedActionId,
    input: invocation.input,
    surface: 'cli',
  });
  const result: PluginCommandExecutionResult = !attempt.matched
    ? {
      ok: false,
      code: 'plugin_command_action_unavailable',
      message: `Plugin command action is unavailable: ${invocation.qualifiedActionId}`,
      qualifiedCommandId: invocation.qualifiedCommandId,
      qualifiedActionId: invocation.qualifiedActionId,
    }
    : !attempt.result.ok
      ? {
        ok: false,
        code: attempt.result.errorCode,
        message: attempt.result.error,
        qualifiedCommandId: invocation.qualifiedCommandId,
        qualifiedActionId: invocation.qualifiedActionId,
      }
      : {
        ok: true,
        qualifiedCommandId: invocation.qualifiedCommandId,
        qualifiedActionId: invocation.qualifiedActionId,
        result: attempt.result.result,
      };
  if (!result.ok) {
    await printPluginCommandFailure(context.args, result);
    return;
  }
  if (wantsPluginCommandJson(context.args)) {
    await printJsonEnvelope({
      ok: true,
      kind: 'plugin_command',
      data: {
        commandId: result.qualifiedCommandId,
        actionId: result.qualifiedActionId,
        result: result.result,
      },
    });
    return;
  }
  console.log(`${ok(`Plugin command completed: ${result.qualifiedCommandId}`)}\n${JSON.stringify(result.result, null, 2)}`);
}
