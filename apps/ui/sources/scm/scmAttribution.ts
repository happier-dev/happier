import {
    type SessionChangeAttribution,
    type CheckpointOverlapObservation,
    type FileChangeEvidence,
} from '@happier-dev/protocol/sessions/changes/types';

import type { ScmFileStatus } from './scmStatusFiles';
import { isDirectoryLikeScmFileStatus } from './isDirectoryLikeScmFileStatus';

export type ChangedFilesViewMode =
    | 'repository'
    | 'selected'
    | 'turn'
    | 'turn_agent_reported'
    | 'turn_checkpoint'
    | 'session';
export type ChangedFilesPresentation = 'list' | 'review';

export type ChangedFilesEmptyStateTranslationKey =
    | 'files.noChanges'
    | 'files.noLatestTurnChanges'
    | 'files.noAgentReportedTurnChanges'
    | 'files.noCheckpointTurnChanges'
    | 'files.noSessionAttributedChanges';

/** One empty-state projection shared by list, review, and right-panel hosts. */
export function resolveChangedFilesEmptyStateTranslationKey(
    mode: ChangedFilesViewMode,
): ChangedFilesEmptyStateTranslationKey {
    if (mode === 'turn') return 'files.noLatestTurnChanges';
    if (mode === 'turn_agent_reported') return 'files.noAgentReportedTurnChanges';
    if (mode === 'turn_checkpoint') return 'files.noCheckpointTurnChanges';
    if (mode === 'session') return 'files.noSessionAttributedChanges';
    return 'files.noChanges';
}

export type SessionAttributedFile = {
    file: ScmFileStatus;
    /** Internal aggregate lineage retained with the evidence projection; never rendered as user copy. */
    turns: readonly string[];
    content: Pick<FileChangeEvidence, 'source' | 'confidence'>;
    attribution: SessionChangeAttribution;
    checkpointOverlap: CheckpointOverlapObservation;
    evidence: readonly FileChangeEvidence[];
};

/** Shared lossless presentation adapter used by every mounted attributed-file surface. */
export function filterPresentableSessionAttributedFiles(
    files: readonly SessionAttributedFile[],
): SessionAttributedFile[] {
    return files.filter((entry) => Boolean(entry?.file) && !isDirectoryLikeScmFileStatus(entry.file));
}

/**
 * Which Changed Files scopes the current evidence can back. One predicate
 * (`isChangedFilesViewModeAvailable`) decides this for every consumer, so the offered scopes and
 * the resolved scope can never disagree.
 */
export type ChangedFilesViewModeAvailability = {
    showTurnViewToggle: boolean;
    showTurnAgentReportedViewToggle?: boolean;
    showTurnCheckpointViewToggle?: boolean;
    showSessionViewToggle: boolean;
    showSelectedViewToggle?: boolean;
};

/** Presentation order of the scopes a host may offer. */
const ORDERED_CHANGED_FILES_VIEW_MODES: readonly ChangedFilesViewMode[] = [
    'repository',
    'selected',
    'turn',
    'turn_agent_reported',
    'turn_checkpoint',
    'session',
];

export function getDefaultChangedFilesViewMode(): ChangedFilesViewMode {
    return 'repository';
}

export function getPreferredChangedFilesViewMode(input: ChangedFilesViewModeAvailability): ChangedFilesViewMode {
    if (input.showTurnViewToggle) return 'turn';
    if (input.showSessionViewToggle) return 'session';
    return getDefaultChangedFilesViewMode();
}

export function isChangedFilesViewModeAvailable(input: ChangedFilesViewModeAvailability & {
    mode: ChangedFilesViewMode;
}): boolean {
    if (input.mode === 'repository') return true;
    if (input.mode === 'selected') return input.showSelectedViewToggle === true;
    if (input.mode === 'turn') return input.showTurnViewToggle;
    if (input.mode === 'turn_agent_reported') return input.showTurnAgentReportedViewToggle === true;
    if (input.mode === 'turn_checkpoint') return input.showTurnCheckpointViewToggle === true;
    return input.showSessionViewToggle;
}

export function resolveChangedFilesViewMode(input: ChangedFilesViewModeAvailability & {
    mode: ChangedFilesViewMode;
}): ChangedFilesViewMode {
    if (isChangedFilesViewModeAvailable(input)) return input.mode;
    return getPreferredChangedFilesViewMode(input);
}

/**
 * Derived from the availability predicate rather than a second list, so a host can never resolve a
 * scope its selector refuses to offer. A lone repository scope is not a choice, so nothing is
 * offered.
 */
export function getSelectableChangedFilesViewModes(input: ChangedFilesViewModeAvailability): ChangedFilesViewMode[] {
    const modes = ORDERED_CHANGED_FILES_VIEW_MODES.filter((mode) => isChangedFilesViewModeAvailable({ ...input, mode }));
    return modes.length > 1 ? modes : [];
}

/**
 * The Git pane's All-changes grouping (session-tabs lab G1): the repository's current changed rows
 * split into the ones this Session's change set attributes to it and the rest of the repository.
 *
 * Both groups keep repository order and hold the repository's own rows (what can be selected,
 * committed and discarded), never the evidence copies; an attributed path that is no longer changed
 * in the repository is in neither group.
 */
export function partitionRepositoryChangesBySession(
    repositoryFiles: readonly ScmFileStatus[],
    sessionAttributedFiles: readonly SessionAttributedFile[],
): Readonly<{ session: ScmFileStatus[]; elsewhere: ScmFileStatus[] }> {
    const sessionPaths = new Set<string>();
    for (const entry of sessionAttributedFiles) {
        if (entry?.file?.fullPath) sessionPaths.add(entry.file.fullPath);
    }
    const session: ScmFileStatus[] = [];
    const elsewhere: ScmFileStatus[] = [];
    for (const file of repositoryFiles) {
        (sessionPaths.has(file.fullPath) ? session : elsewhere).push(file);
    }
    return { session, elsewhere };
}
