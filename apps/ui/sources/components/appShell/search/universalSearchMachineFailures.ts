import { SelectionListSectionFailure } from '@/components/ui/selectionList/selectionListSectionFailure';
import type { WorkspaceFileContentSearchPage } from '@/sync/domains/workspaces/files/workspaceFileContentSearch';
import { WorkspaceFileSearchUnavailableError } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import type { WorkspaceCommitSearchOutcome } from '@/scm/search/searchWorkspaceCommits';
import { t } from '@/text';
import type { PluginSearchResultV1 } from '@happier-dev/protocol/plugins/contributions/search-providers';

/**
 * What the machine-backed groups (Files, Text in files, Commits) say when the daemon could not answer.
 * A failure names its real cause and next step; groups that fail for the same cause share a `causeKey`
 * so the palette says it once (`SelectionListSectionFailure`).
 */

/** The folder itself is gone: one folder-level line, whichever group found out first. */
const FOLDER_MISSING_CAUSE = 'workspaceFolderMissing';

/** There is nothing to retry: the next step is choosing another folder. */
export function workspaceFolderMissingFailure(): SelectionListSectionFailure {
    return new SelectionListSectionFailure({
        hint: t('errors.workspaceFolderMissing'),
        causeKey: FOLDER_MISSING_CAUSE,
        retryable: false,
    });
}

/** The machine did not answer: one machine-level line, under the first group that asked, whose Retry re-runs them all. */
const MACHINE_NOT_ANSWERING_CAUSE = 'machineNotAnswering';

export function machineNotAnsweringFailure(machine: string): SelectionListSectionFailure {
    return new SelectionListSectionFailure({ hint: t('universalSearch.machineNotAnswering', { machine }), causeKey: MACHINE_NOT_ANSWERING_CAUSE });
}

/** Files: the folder or machine causes it knows become their shared line; anything else stays the group's own failure. */
export function presentFileSearchError(error: unknown, input: Readonly<{ machine: string }>): unknown {
    if (!(error instanceof WorkspaceFileSearchUnavailableError)) return error;
    if (error.errorCode === 'root_not_found') return workspaceFolderMissingFailure();
    if (error.errorCode === 'transport_failed' || error.errorCode === 'target_unavailable') return machineNotAnsweringFailure(input.machine);
    return error;
}

/** Plugin acquisition facts use the same presentation owner as machine groups. */
export function presentPluginSearchFailure(
    failure: NonNullable<PluginSearchResultV1['failure']>,
    group: string,
): SelectionListSectionFailure {
    if (failure.code === 'root_not_found') return workspaceFolderMissingFailure();
    return new SelectionListSectionFailure({ hint: t('universalSearch.groupFailed', { group }) });
}

type ContentSearchError = NonNullable<WorkspaceFileContentSearchPage['error']>;

export type ContentSearchErrorPresentation =
    /** The user's own next step (update the machine, fix the pattern), not a failure. */
    | Readonly<{ kind: 'statement'; hint: string }>
    | Readonly<{ kind: 'failure'; failure: SelectionListSectionFailure }>;

export function presentContentSearchError(
    error: ContentSearchError,
    input: Readonly<{ machine: string; group: string }>,
): ContentSearchErrorPresentation {
    switch (error) {
        case 'root_not_found':
            return { kind: 'failure', failure: workspaceFolderMissingFailure() };
        case 'update_required':
            return { kind: 'statement', hint: t('universalSearch.content.updateRequired') };
        case 'invalid_pattern':
            return { kind: 'statement', hint: t('universalSearch.content.invalidPattern') };
        case 'ripgrep_unavailable':
            return { kind: 'failure', failure: new SelectionListSectionFailure({ hint: t('universalSearch.textUnavailableOnMachine', { machine: input.machine }) }) };
        case 'target_unavailable':
        case 'transport_failed':
            return { kind: 'failure', failure: machineNotAnsweringFailure(input.machine) };
        default:
            return { kind: 'failure', failure: new SelectionListSectionFailure({ hint: t('universalSearch.groupFailed', { group: input.group }) }) };
    }
}

export function presentCommitSearchFailure(
    outcome: Extract<WorkspaceCommitSearchOutcome, { status: 'unavailable' }>,
    input: Readonly<{ machine: string; folder: string }>,
): SelectionListSectionFailure | null {
    switch (outcome.reason) {
        case 'rootNotFound':
            return workspaceFolderMissingFailure();
        case 'backendUnavailable':
            return new SelectionListSectionFailure({ hint: t('universalSearch.commitsUnavailableOnMachine', { machine: input.machine }) });
        case 'unreachable':
            return machineNotAnsweringFailure(input.machine);
        case 'notRepository':
            return new SelectionListSectionFailure({ hint: `${input.folder} · ${t('files.notRepo')}`, retryable: false });
        case 'unsupported':
            return new SelectionListSectionFailure({ hint: t('universalSearch.commitsUpdateRequired'), retryable: false });
        default:
            return null;
    }
}
