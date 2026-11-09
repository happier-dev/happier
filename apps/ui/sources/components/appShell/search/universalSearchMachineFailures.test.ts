import { describe, expect, it } from 'vitest';

import { SelectionListSectionFailure } from '@/components/ui/selectionList/selectionListSectionFailure';
import { t } from '@/text';

import { WorkspaceFileSearchUnavailableError } from '@/sync/domains/workspaces/files/workspaceFileSearch';

import { presentCommitSearchFailure, presentContentSearchError, presentFileSearchError, workspaceFolderMissingFailure } from './universalSearchMachineFailures';

const input = { machine: 'MacBook Pro', folder: '/tmp', group: 'Text in files' };

describe('machine-backed search failures', () => {
    it.each(['notRepository', 'unsupported'] as const)('does not offer Retry for %s', (reason) => {
        const failure = presentCommitSearchFailure({ status: 'unavailable', reason }, input);
        expect(failure).toBeInstanceOf(SelectionListSectionFailure);
        expect(failure?.retryable).toBe(false);
        expect(failure?.hint).toContain(reason === 'notRepository' ? '/tmp' : t('universalSearch.commitsUpdateRequired'));
    });
    it('names a missing folder once, for every group, and offers no retry', () => {
        const content = presentContentSearchError('root_not_found', input);
        const commits = presentCommitSearchFailure({ status: 'unavailable', reason: 'rootNotFound' }, input);
        if (content.kind !== 'failure' || !commits) throw new Error('missing folder must be a failure');
        expect(content.failure.causeKey).toBeDefined();
        expect(content.failure.causeKey).toBe(commits.causeKey);
        expect(content.failure.causeKey).toBe(workspaceFolderMissingFailure().causeKey);
        expect(content.failure.retryable).toBe(false);
        expect(content.failure.hint).toBe(t('errors.workspaceFolderMissing'));
    });

    it('says a machine that is not answering once for Files, Text in files and Commits, with one Retry', () => {
        const files = presentFileSearchError(new WorkspaceFileSearchUnavailableError('transport_failed'), input);
        const content = presentContentSearchError('transport_failed', input);
        const commits = presentCommitSearchFailure({ status: 'unavailable', reason: 'unreachable' }, input);
        if (content.kind !== 'failure' || !commits || !(files instanceof SelectionListSectionFailure)) throw new Error('an unreachable machine must be a failure');
        for (const failure of [files, content.failure, commits]) {
            expect(failure.causeKey).toBeDefined();
            expect(failure.causeKey).toBe(content.failure.causeKey);
            expect(failure.hint).toBe(t('universalSearch.machineNotAnswering', { machine: 'MacBook Pro' }));
            expect(failure.retryable).toBe(true);
        }
        expect(content.failure.causeKey).not.toBe(workspaceFolderMissingFailure().causeKey);
        // A file search failure the presenter does not own reaches the generic group line unchanged.
        const other = new Error('boom');
        expect(presentFileSearchError(other, input)).toBe(other);
    });

    it('says a missing tool is not available on the named machine and stays retryable', () => {
        const content = presentContentSearchError('ripgrep_unavailable', input);
        const commits = presentCommitSearchFailure({ status: 'unavailable', reason: 'backendUnavailable' }, input);
        if (content.kind !== 'failure' || !commits) throw new Error('missing tool must be a failure');
        expect(content.failure.hint).toBe(t('universalSearch.textUnavailableOnMachine', { machine: 'MacBook Pro' }));
        expect(commits.hint).toBe(t('universalSearch.commitsUnavailableOnMachine', { machine: 'MacBook Pro' }));
        for (const failure of [content.failure, commits]) {
            expect(failure.hint).not.toBe(t('universalSearch.content.unavailable'));
            expect(failure.retryable).toBe(true);
            // Different tools are different causes: neither line may swallow the other.
            expect(failure.causeKey).toBeUndefined();
        }
        expect(content.failure.hint).not.toBe(commits.hint);
    });

    it('keeps the user\'s own next step a statement, not a failure', () => {
        expect(presentContentSearchError('update_required', input).kind).toBe('statement');
        expect(presentContentSearchError('invalid_pattern', input).kind).toBe('statement');
    });

    it('names the failed group for causes it does not know, and leaves unknown commit failures to the generic group line', () => {
        const unknown = presentContentSearchError('ripgrep_failed', input);
        if (unknown.kind !== 'failure') throw new Error('expected failure');
        expect(unknown.failure).toBeInstanceOf(SelectionListSectionFailure);
        expect(unknown.failure.hint).toBe(t('universalSearch.groupFailed', { group: 'Text in files' }));
        expect(presentCommitSearchFailure({ status: 'unavailable', reason: 'error' }, input)).toBeNull();
    });
});
