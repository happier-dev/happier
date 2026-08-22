import { errorFrame, ok } from '@happier-dev/cli-common/output';

import { configuration } from '@/configuration';
import { requestDaemonPluginActionExecution } from '@/daemon/controlClient';
import { ensureDaemonRunningForSessionCommand } from '@/daemon/ensureDaemon';
import type { CliCommandSurfaceEntry } from './commandSurfaceManifest';
import type { CommandContext } from './commandRegistry';
import { printJsonEnvelope, wantsJson } from './output/jsonEnvelope';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
  type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/protocol';

export type PluginCommandProjectionEntry = Readonly<{
  qualifiedId: string;
  qualifiedActionId: string;
  path: readonly string[];
  title: string;
  description?: string;
  visibility: 'default' | 'advanced';
  tmux: 'inherit' | 'required' | 'forbidden';
  status: 'available' | 'unavailable' | 'ambiguous';
  unavailableCode?: string;
}>;

export type PluginCommandProjectionDiagnostic = Readonly<{
  code: string;
  qualifiedId: string;
}>;

export type PluginCommandProjection = Readonly<{
  roots: readonly string[];
  commands: readonly PluginCommandProjectionEntry[];
  rootHelpEntries: readonly CliCommandSurfaceEntry[];
  diagnostics: readonly PluginCommandProjectionDiagnostic[];
}>;

let currentPluginCommandRootHelpEntries: readonly CliCommandSurfaceEntry[] = Object.freeze([]);

export function setProjectedPluginCommandRootHelpEntries(entries: readonly CliCommandSurfaceEntry[]): void {
  currentPluginCommandRootHelpEntries = entries;
}

export function listProjectedPluginCommandRootHelpEntries(): readonly CliCommandSurfaceEntry[] {
  return currentPluginCommandRootHelpEntries;
}

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

const COMMAND_PATH_SEGMENT = /^[a-z][a-z0-9-]*$/;
const TERMINAL_ESCAPE_SEQUENCE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\|$)|[PX^_][\s\S]*?(?:\u001b\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/gu;
const TERMINAL_CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

function sanitizePluginCommandDisplayText(value: string): string | null {
  const sanitized = value
    .replace(TERMINAL_ESCAPE_SEQUENCE, '')
    .replace(TERMINAL_CONTROL_OR_BIDI, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return sanitized || null;
}

function readLocalizedText(value: unknown): string | null {
  if (typeof value === 'string') {
    return sanitizePluginCommandDisplayText(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fallback = (value as Readonly<{ fallback?: unknown }>).fallback;
  return typeof fallback === 'string' ? sanitizePluginCommandDisplayText(fallback) : null;
}

function qualifiedCommandId(command: ResolvedCommandContribution): string | null {
  const pluginId = command.pluginId?.trim();
  const localId = command.definition.id.trim();
  return pluginId && localId ? `${pluginId}/${localId}` : null;
}

function compareCommands(
  left: PluginCommandProjectionEntry,
  right: PluginCommandProjectionEntry,
): number {
  const pathComparison = left.path.join('\u0000').localeCompare(right.path.join('\u0000'));
  return pathComparison || left.qualifiedId.localeCompare(right.qualifiedId);
}

export function resolvePluginCommandProjection(params: Readonly<{
  registry: ResolvedContributionRegistry;
  reservedRoots: ReadonlySet<string>;
  facts?: ContributionPolicyFacts;
}>): PluginCommandProjection {
  const diagnostics: PluginCommandProjectionDiagnostic[] = [];
  const admitted: PluginCommandProjectionEntry[] = [];

  for (const command of params.registry.commands ?? []) {
    const qualifiedId = qualifiedCommandId(command);
    if (!qualifiedId) continue;
    const path = command.definition.path.map((segment) => segment.trim());
    const root = path[0];
    if (!root || path.some((segment) => !COMMAND_PATH_SEGMENT.test(segment))) {
      diagnostics.push(Object.freeze({ code: 'plugin_command_path_invalid', qualifiedId }));
      continue;
    }
    if (params.reservedRoots.has(root)) {
      diagnostics.push(Object.freeze({ code: 'plugin_command_path_reserved', qualifiedId }));
      continue;
    }

    const availability = evaluateContributionAvailability({
      availability: command.definition.availability,
      facts: resolveInvocationContributionPolicyFacts({ facts: params.facts }),
    });
    admitted.push(Object.freeze({
      qualifiedId,
      qualifiedActionId: command.definition.actionId,
      path: Object.freeze(path),
      title: readLocalizedText(command.definition.title) ?? command.definition.id,
      ...(readLocalizedText(command.definition.description)
        ? { description: readLocalizedText(command.definition.description)! }
        : {}),
      visibility: command.definition.visibility ?? 'default',
      tmux: command.definition.tmux ?? 'inherit',
      status: availability.outcome === 'visible' ? 'available' : 'unavailable',
      ...(availability.outcome !== 'visible'
        ? { unavailableCode: availability.code }
        : {}),
    }));
  }

  const commandsByPath = new Map<string, PluginCommandProjectionEntry[]>();
  for (const command of admitted) {
    const key = command.path.join('\u0000');
    const atPath = commandsByPath.get(key) ?? [];
    atPath.push(command);
    commandsByPath.set(key, atPath);
  }

  const commands = admitted.map((command) => {
    const atPath = commandsByPath.get(command.path.join('\u0000')) ?? [];
    if (atPath.length < 2) return command;
    diagnostics.push(Object.freeze({
      code: 'plugin_command_path_ambiguous',
      qualifiedId: command.qualifiedId,
    }));
    return Object.freeze({
      ...command,
      status: 'ambiguous' as const,
      unavailableCode: 'plugin_command_path_ambiguous',
    });
  }).sort(compareCommands);

  const roots = [...new Set(commands.map((command) => command.path[0]!))].sort();
  const rootHelpEntries = roots.flatMap((root): CliCommandSurfaceEntry[] => {
    const visibleCommands = commands.filter((command) => (
      command.path[0] === root
      && command.status === 'available'
      && command.visibility === 'default'
    ));
    if (visibleCommands.length === 0) return [];
    const description = visibleCommands.length === 1
      ? visibleCommands[0]!.description ?? visibleCommands[0]!.title
      : 'Plugin commands';
    return [{
      command: root,
      rootHelpLabel: `happier ${root}`,
      rootHelpDescription: description,
      allowTmux: visibleCommands.some((command) => command.tmux !== 'forbidden'),
    }];
  });

  return Object.freeze({
    roots: Object.freeze(roots),
    commands: Object.freeze(commands),
    rootHelpEntries: Object.freeze(rootHelpEntries.map((entry) => Object.freeze(entry))),
    diagnostics: Object.freeze(diagnostics),
  });
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
