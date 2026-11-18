import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';

/** The four ways a session's folder gets into a sandbox (lab machine-sandboxes-1115 round 4). */
export type ProjectFilesOptionId =
  | 'copy_once'
  | 'git_clone'
  | 'keep_synced'
  | 'keep_both_in_sync';

/**
 * The one option list for "How files get in": the preset's select and the New Session override read titles,
 * meanings and marks from here, so the two can't drift. Copy once is what a preset without a choice does.
 */
export const PROJECT_FILES_OPTIONS = [
  {
    id: 'copy_once',
    groupTitleKey: 'machineDetailPage.projectFiles.groupCopyOnce',
    titleKey: 'machineDetailPage.projectFiles.copyOnce',
    subtitleKey: 'machineDetailPage.projectFiles.copyOnceHelp',
    forSessionKey: 'machineDetailPage.projectFiles.forSessionCopyOnce',
    mark: 'default',
  },
  {
    id: 'git_clone',
    groupTitleKey: 'machineDetailPage.projectFiles.groupGitClone',
    titleKey: 'machineDetailPage.projectFiles.gitClone',
    subtitleKey: 'machineDetailPage.projectFiles.gitCloneHelp',
    forSessionKey: 'machineDetailPage.projectFiles.forSessionGitClone',
    mark: null,
  },
  {
    id: 'keep_synced',
    groupTitleKey: 'machineDetailPage.projectFiles.groupSync',
    titleKey: 'machineDetailPage.projectFiles.keepSynced',
    subtitleKey: 'machineDetailPage.projectFiles.keepSyncedHelp',
    forSessionKey: 'machineDetailPage.projectFiles.forSessionKeepSynced',
    mark: null,
  },
  {
    id: 'keep_both_in_sync',
    groupTitleKey: 'machineDetailPage.projectFiles.groupSync',
    titleKey: 'machineDetailPage.projectFiles.twoWay',
    subtitleKey: 'machineDetailPage.projectFiles.twoWayHelp',
    forSessionKey: 'machineDetailPage.projectFiles.forSessionTwoWay',
    mark: 'advanced',
  },
] as const satisfies readonly Readonly<{
  id: ProjectFilesOptionId;
  titleKey: string;
  /** The option's own settings group says what it configures, never the option's name again. */
  groupTitleKey: string;
  subtitleKey: string;
  forSessionKey: string;
  mark: 'default' | 'advanced' | null;
}>[];

export type ProjectFilesOption = (typeof PROJECT_FILES_OPTIONS)[number];

/** A preset without a choice copies once (the daemon's own default). */
export function projectFilesOptionId(
  value: SessionProjectFilesV1 | undefined,
): ProjectFilesOptionId {
  if (!value) return 'copy_once';
  return value.kind === 'sync' ? value.mode : value.kind;
}

export function projectFilesOption(
  value: SessionProjectFilesV1 | undefined,
): ProjectFilesOption {
  const id = projectFilesOptionId(value);
  return PROJECT_FILES_OPTIONS.find((option) => option.id === id)!;
}

/**
 * The value a chosen option stores, keeping the folder's content choices when moving between the copy and sync
 * options. Git clone without its own repository and branch takes the session folder's (resolved by the daemon
 * before any credential is chosen); a clone already naming them keeps them.
 */
export function projectFilesValueForOption(
  id: ProjectFilesOptionId,
  previous: SessionProjectFilesV1 | undefined,
): SessionProjectFilesV1 {
  const contentPolicy =
    previous && previous.kind !== 'git_clone'
      ? previous.contentPolicy
      : undefined;
  const content = contentPolicy ? { contentPolicy } : {};
  if (id === 'copy_once') return { kind: 'copy_once', ...content };
  if (id === 'git_clone') return previous?.kind === 'git_clone' ? previous : { kind: 'git_clone' };
  return { kind: 'sync', mode: id, ...content };
}
