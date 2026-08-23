import { errorFrame, ok } from '@happier-dev/cli-common/output';

import { configuration } from '@/configuration';
import { requestDaemonPluginActionExecution } from '@/daemon/controlClient';
import { ensureDaemonRunningForSessionCommand } from '@/daemon/ensureDaemon';
import type { CommandContext } from './commandRegistry';
import { printJsonEnvelope, wantsJson } from './output/jsonEnvelope';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol';
import {
  resolvePluginCommandProjection,
  type PluginCommandProjection,
} from './pluginCommandProjection';

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
  try {
    return isValidPluginJsonSchemaValue(compilePluginJsonSchema(schema), input);
  } catch {
    return false;
  }
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
  const parsed = parseInvocationArgs(params.args);
  if (!parsed.ok) {
    return { ok: false, code: 'plugin_command_arguments_invalid', message: parsed.message };
  }
  if (parsed.path[0] !== params.root) {
    return { ok: false, code: 'plugin_command_unknown', message: `Unknown plugin command: ${parsed.path.join(' ')}` };
  }

  const projection = resolvePluginCommandProjection({
    registry: params.registry,
    reservedRoots: params.reservedRoots ?? new Set(),
  });
  const matches = projection.commands.filter((command) => (
    command.path.length === parsed.path.length
    && command.path.every((segment, index) => segment === parsed.path[index])
  ));
  if (matches.length === 0) {
    return { ok: false, code: 'plugin_command_unknown', message: `Unknown plugin command: ${parsed.path.join(' ')}` };
  }
  if (matches.length !== 1 || matches[0]!.status === 'ambiguous') {
    return { ok: false, code: 'plugin_command_path_ambiguous', message: `Ambiguous plugin command: ${parsed.path.join(' ')}` };
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
  if (!validateCommandArguments(contribution, parsed.input)) {
    return {
      ok: false,
      code: 'plugin_command_arguments_invalid',
      message: 'Plugin command input does not match its manifest arguments schema',
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
  if (wantsJson(args)) {
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
  console.error(errorFrame('Error:', [failure.message]));
  process.exitCode = 1;
}

function renderPluginCommandHelp(params: Readonly<{
  projection: PluginCommandProjection;
  root: string;
  args: readonly string[];
}>): string {
  const requestedPath = params.args.filter((token) => !token.startsWith('-'));
  const exact = params.projection.commands.find((command) => (
    command.path.length === requestedPath.length
    && command.path.every((segment, index) => segment === requestedPath[index])
  ));
  if (exact) {
    return [
      `${exact.title}`,
      exact.description ?? '',
      '',
      `Usage: happier ${exact.path.join(' ')} [--input <json>] [--json]`,
      `Command: ${exact.qualifiedId}`,
      `Action: ${exact.qualifiedActionId}`,
      ...(exact.status === 'available'
        ? []
        : [`Unavailable: ${exact.unavailableCode ?? 'plugin_command_unavailable'}`]),
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== '')).join('\n');
  }

  const commands = params.projection.commands.filter((command) => (
    command.path[0] === params.root
    && command.status === 'available'
    && command.visibility === 'default'
  ));
  return [
    `Usage: happier ${params.root} <command> [--input <json>] [--json]`,
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
    || context.args.includes('--help')
    || context.args.includes('-h');
  if (asksForHelp) {
    const text = renderPluginCommandHelp({ projection, root, args: context.args });
    if (wantsJson(context.args)) {
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
  if (wantsJson(context.args)) {
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
