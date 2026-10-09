import { isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import type {
  ProjectCommandSourceV1,
  ProjectEnvironmentSelectionV1,
  ProjectNativeRefV1,
  ProjectToolInspectionV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import {
  isActionOperationTerminal,
  resolveActionOperationObservation,
} from '@/sync/domains/actionOperations/actionOperationStore';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';

type NativeTool = Extract<ProjectCommandSourceV1, { kind: 'native' }>['tool'];
type ToolchainTool = Extract<
  ProjectEnvironmentSelectionV1,
  { kind: 'toolchain' }
>['tool'];

/** Display names for the closed native tool and toolchain enums; raw ids never reach the screen. */
const TOOL_LABELS: Readonly<Record<NativeTool | ToolchainTool, string>> = {
  package_script: 'package.json',
  mise: 'mise',
  make: 'make',
  just: 'just',
  taskfile: 'Task',
  turbo: 'Turborepo',
  compose: 'Docker Compose',
  procfile: 'Procfile',
  devbox: 'Devbox',
  devenv: 'devenv',
  flox: 'Flox',
  nix_flake: 'Nix flake',
};

export function describeProjectTool(tool: NativeTool | ToolchainTool): string {
  return TOOL_LABELS[tool];
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

type ProjectInvocationPreview = Readonly<{ tool: string; args: readonly string[] }>;
type ProjectInvocationRow = Readonly<{ source: ProjectNativeRefV1; invocation?: ProjectInvocationPreview }>;

function formatProjectInvocation(invocation: ProjectInvocationPreview): string {
  return [invocation.tool, ...invocation.args]
    .map((part) => (part === '' || /\s|"/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

/** The runner argv inspection previewed for a native reference (named commands, then import offers). */
export function findProjectInvocation(
  inspection: Readonly<{ commands?: readonly ProjectInvocationRow[]; importCandidates: readonly ProjectInvocationRow[] }>,
  source: ProjectCommandSourceV1,
): ProjectInvocationPreview | undefined {
  if (source.kind === 'command') return undefined;
  return [...(inspection.commands ?? []), ...inspection.importCandidates]
    .find((entry) => entry.invocation && isSameInputOptionValue(entry.source, source))?.invocation;
}

/**
 * Where a declaration comes from and what it names, read from the source itself; nothing is resolved
 * here. The badge names the file a reader recognises (package.json, Makefile, compose.yaml) or the
 * tool whose own configuration declares it (mise, just, Devbox).
 */
export function describeProjectCommandSource(
  source: ProjectCommandSourceV1,
  invocation?: ProjectInvocationPreview,
): Readonly<{
  file: string | null;
  badge: string | null;
  target: string;
  reference: string;
  /** What runs: a literal command, or the runner argv inspection previewed ("yarn test"); never guessed. */
  command: string | null;
}> {
  if (source.kind === 'command')
    return {
      file: null,
      badge: null,
      target: source.command,
      reference: source.command,
      command: source.command,
    };
  const badge =
    source.kind === 'pluginNative'
      ? source.adapter.localId
      : ['package_script', 'make', 'compose', 'procfile'].includes(source.tool)
        ? basename(source.file)
        : describeProjectTool(source.tool);
  return {
    file: source.file,
    badge,
    target: source.target,
    reference: `${source.file}#${source.target}`,
    command: invocation ? formatProjectInvocation(invocation) : null,
  };
}

/** "mise · .mise.toml" for the selected environment; the machine's own tools read as such. */
export function describeProjectEnvironment(
  selection: ProjectEnvironmentSelectionV1,
): Readonly<{ title: string; config: string | null }> {
  if (selection.kind === 'host')
    return { title: t('projects.scripts.editor.hostTools'), config: null };
  const title =
    selection.kind === 'toolchain'
      ? describeProjectTool(selection.tool)
      : selection.adapter.localId;
  return { title, config: selection.configPath ?? null };
}

/** "node 22.11.0" for each tool whose installed version inspection observed; unknown versions stay out. */
export function describeProjectToolVersions(tools: readonly ProjectToolInspectionV1[] | undefined): string[] {
  return (tools ?? []).flatMap((tool) => (tool.version ? [`${tool.tool} ${tool.version}`] : []));
}

export type ProjectRunGlyph =
  | 'idle'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'attention';
export type ProjectRunTone = 'quiet' | 'attention' | 'danger';
export type ProjectRunPresentation = Readonly<{
  glyph: ProjectRunGlyph;
  tone: ProjectRunTone;
  text: string;
  /** Run becomes Stop in the same slot while the process can still be stopped. */
  live: boolean;
  startedAt: number | null;
  /** Strict producer progress, not a phase inferred from accepted/running. */
  phase: string | null;
  /** Absent is unknown; zero is a real queue position. Only meaningful while queued. */
  queueAhead: number | null;
  /** The producer's latest output line while it runs (operation progress label), shown in mono. */
  tail: string | null;
}>;

/** "1 min 48 s", "42 s", "1 h 3 min": how long an observed run took. */
export function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60)
    return t('projects.scripts.run.durationSeconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return t('projects.scripts.run.durationMinutes', {
      minutes,
      seconds: seconds % 60,
    });
  return t('projects.scripts.run.durationHours', {
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}

/**
 * How one finite run reads on a Scripts row, from the operation snapshot alone (plan 21 §2 copy).
 * Unknown, unconfirmed and offline facts never read as completed or failed.
 */
export function presentProjectRun(
  operation: ActionOperationProjection | null,
  machineName: string | null,
  idleText: string,
): ProjectRunPresentation {
  if (!operation)
    return {
      glyph: 'idle',
      tone: 'quiet',
      text: idleText,
      live: false,
      startedAt: null,
      phase: null,
      queueAhead: null,
      tail: null,
    };
  const { snapshot } = operation;
  const attachment = snapshot.domainRef?.kind === 'projectCommand' ? snapshot.domainRef : null;
  // The strict snapshot's required timestamp alone does not establish that a process launched.
  const startedAt = attachment?.terminalId ? snapshot.startedAt ?? null : null;
  const phaseProgress = snapshot.progress?.kind === 'phase' ? snapshot.progress : null;
  const phase = phaseProgress?.phase ?? null;
  const queueAhead = phase === 'queued' && !isActionOperationTerminal(snapshot.state)
    ? phaseProgress?.queueAhead ?? null : null;
  const machine = machineName ?? attachment?.machineId ?? snapshot.scope.machineId;
  const live = (
    glyph: ProjectRunGlyph,
    tone: ProjectRunTone,
    text: string,
  ): ProjectRunPresentation => ({
    glyph,
    tone,
    text,
    live: true,
    startedAt,
    phase,
    queueAhead,
    tail: snapshot.progress?.label ?? null,
  });
  if (!isActionOperationTerminal(snapshot.state)) {
    if (snapshot.observation?.kind === 'stop_unconfirmed')
      return live(
        'attention',
        'attention',
        t('projects.scripts.run.stopUnconfirmed'),
      );
    if (snapshot.observation?.kind === 'outcome_uncertain')
      return live('attention', 'attention', t('projects.scripts.run.unknown'));
    if (snapshot.setupReview)
      return live(
        'attention',
        'attention',
        t('projects.scripts.setup.pending'),
      );
    if (
      resolveActionOperationObservation(snapshot, operation.observation) ===
      'unavailable'
    ) {
      return live('attention', 'quiet', t('projects.scripts.run.offline'));
    }
    // Queue and preparation come from the target's own phase facts (plan 31 §2), never inferred.
    if (phase === 'queued')
      return live('queued', 'quiet', [t('projectWorkers.queuedOn', { machine }),
        queueAhead && queueAhead > 0 ? t('projectWorkers.ahead', { count: queueAhead }) : null].filter(Boolean).join(' · '));
    if (phase === 'copying') return live('queued', 'quiet', t('projectWorkers.copying', { machine }));
    if (phase === 'preparing' || phase === 'setup') return live('queued', 'quiet', t('projectWorkers.preparing', { machine }));
    return snapshot.state === 'accepted'
      ? live('queued', 'quiet', t('projects.scripts.run.accepted'))
      : live(
          'running',
          'quiet',
          t('projects.scripts.run.running', { machine }),
        );
  }
  const settledAt = snapshot.settledAt ?? snapshot.createdAt;
  const at = formatAsOfTime(settledAt);
  const duration =
    startedAt !== null ? ` · ${formatRunDuration(settledAt - startedAt)}` : '';
  const done = (
    glyph: ProjectRunGlyph,
    tone: ProjectRunTone,
    text: string,
  ): ProjectRunPresentation => ({
    glyph,
    tone,
    text,
    live: false,
    startedAt,
    phase,
    queueAhead,
    tail: null,
  });
  if (snapshot.state === 'succeeded')
    return done(
      'succeeded',
      'quiet',
      `${t('projects.scripts.run.completed', { time: at })}${duration}`,
    );
  if (snapshot.state === 'cancelled')
    return done(
      'stopped',
      'quiet',
      `${t('projects.scripts.run.stopped', { time: at })}${duration}`,
    );
  // Plan 21 copy: an observed nonzero step exit reads "Exited with code N at 10:12".
  const observedStepExit = attachment?.exitCode !== undefined
    && (snapshot.error?.errorCode === 'project_command_step_failed' || snapshot.error?.errorCode === 'project_setup_step_failed')
    ? attachment.exitCode : null;
  return done(
    'failed',
    'danger',
    `${observedStepExit !== null
      ? t('projects.scripts.run.exited', { code: observedStepExit, time: at })
      : t('projects.scripts.run.failed', { time: at })}${duration}`,
  );
}

export function formatRunClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "package.json, mise.toml and Makefile" from the files that declared something, in found order. */
export function joinProjectFiles(files: readonly string[]): string {
  const unique = [...new Set(files.map(basename))];
  if (unique.length <= 1) return unique[0] ?? '';
  return t('projects.scripts.filesList', {
    head: unique.slice(0, -1).join(', '),
    last: unique[unique.length - 1]!,
  });
}
