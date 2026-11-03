import type { CliCommandSurfaceEntry } from './commandSurfaceManifest';
import type { PluginActionContributionV2 } from '@happier-dev/protocol';
import type { ContributionAvailabilityDecision } from '@happier-dev/protocol/plugins/contributions/public-types';
import { findCliCommandPathConflicts } from './commandPathClaims';

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

/** Longest available command prefix, shared by field compilation and admitted reads. */
export function findPluginCommandCompletionCommand(projection: PluginCommandProjection, committed: readonly string[]): PluginCommandProjectionEntry | null {
  return projection.commands.filter((candidate) => (
    candidate.status === 'available'
    && candidate.path.length <= committed.length
    && candidate.path.every((segment, index) => committed[index] === segment)
  )).sort((left, right) => right.path.length - left.path.length)[0] ?? null;
}

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

export type PluginCommandActionMetadata = Readonly<{
  pluginId?: string;
  definition: Readonly<{ id: string }>;
  admittedTarget?: Readonly<{
    declaration: Pick<PluginActionContributionV2, 'id' | 'title' | 'description' | 'cli'> & Readonly<{ surfaces: readonly string[] }>;
  }>;
}>;

function qualifiedCommandId(command: PluginCommandActionMetadata): string | null {
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

export function resolvePluginCommandMetadata<T extends PluginCommandActionMetadata>(params: Readonly<{
  registry: Readonly<{ actions?: readonly T[] }>;
  resolveAvailability(command: T): ContributionAvailabilityDecision;
  reservedRoots: ReadonlySet<string>;
}>): PluginCommandProjection {
  const diagnostics: PluginCommandProjectionDiagnostic[] = [];
  const admitted: PluginCommandProjectionEntry[] = [];

  for (const command of params.registry.actions ?? []) {
    const declaration = command.admittedTarget?.declaration;
    if (!declaration?.surfaces.includes('cli') || !declaration.cli) continue;
    const qualifiedId = qualifiedCommandId(command);
    if (!qualifiedId) continue;
    const availability = params.resolveAvailability(command);
    const paths = [declaration.cli.path, ...(declaration.cli.aliases ?? [])];
    const seenPaths = new Set<string>();
    for (const declaredPath of paths) {
      const path = declaredPath.map((segment) => segment.trim());
      const pathKey = path.join('\u0000');
      if (seenPaths.has(pathKey)) continue;
      seenPaths.add(pathKey);
      const root = path[0];
      if (!root || path.some((segment) => !COMMAND_PATH_SEGMENT.test(segment))) {
        diagnostics.push(Object.freeze({ code: 'plugin_command_path_invalid', qualifiedId }));
        continue;
      }
      if (params.reservedRoots.has(root)) {
        diagnostics.push(Object.freeze({ code: 'plugin_command_path_reserved', qualifiedId }));
        continue;
      }

      admitted.push(Object.freeze({
        qualifiedId,
        qualifiedActionId: qualifiedId,
        path: Object.freeze(path),
        title: readLocalizedText(declaration.title) ?? declaration.id,
        ...(readLocalizedText(declaration.description)
          ? { description: readLocalizedText(declaration.description)! }
          : {}),
        visibility: declaration.cli.visibility ?? 'default',
        tmux: declaration.cli.tmux ?? 'inherit',
        status: availability.outcome === 'visible' ? 'available' : 'unavailable',
        ...(availability.outcome !== 'visible'
          ? { unavailableCode: availability.code }
          : {}),
      }));
    }
  }

  const commandPathKey = (command: Readonly<{ qualifiedId: string; path: readonly string[] }>) => (
    command.qualifiedId + '\u0000' + command.path.join('\u0000')
  );
  const ambiguousPaths = new Set(
    findCliCommandPathConflicts(admitted.map((command) => ({
      source: 'plugin' as const,
      ownerId: command.qualifiedId,
      path: command.path,
    }))).filter((conflict) => conflict.left.ownerId !== conflict.right.ownerId)
      .flatMap((conflict) => [conflict.left, conflict.right].map((claim) => commandPathKey({
        qualifiedId: claim.ownerId, path: claim.path,
      }))),
  );

  const commands = admitted.map((command) => {
    if (!ambiguousPaths.has(commandPathKey(command))) return command;
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

