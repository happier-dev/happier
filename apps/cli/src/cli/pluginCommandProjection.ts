import type { CliCommandSurfaceEntry } from './commandSurfaceManifest';
import type {
  ResolvedCommandContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import {
  evaluateContributionAvailability,
  resolveInvocationContributionPolicyFacts,
  type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';

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
  return pluginId && localId ? pluginId + '/' + localId : null;
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
      rootHelpLabel: 'happier ' + root,
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
