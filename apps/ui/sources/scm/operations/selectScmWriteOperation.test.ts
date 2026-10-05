import { describe, expect, it } from 'vitest';

import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { selectScmWriteOperation, selectLastSuccessfulScmPushAt } from './selectScmWriteOperation';
import type { ScmOperationOutcome } from '@happier-dev/protocol/scm';

function failedEntry(errorCode: ScmProjectOperationLogEntry['errorCode'], detail: string): ScmProjectOperationLogEntry {
    return { id: '1', sessionId: 'session', operation: 'push', status: 'failed', timestamp: 1, errorCode, detail };
}

describe('selectScmWriteOperation', () => {
    it('retains the actual successful push time across later commits and uncertain remote outcomes', () => {
        const pushed: ScmProjectOperationLogEntry = { id: 'p', sessionId: 'session', operation: 'push', status: 'success', timestamp: 7 };
        const committed: ScmProjectOperationLogEntry = { ...pushed, id: 'c', operation: 'commit', timestamp: 9 };
        const uncertain: ScmProjectOperationLogEntry = { ...pushed, id: 'u', timestamp: 10, outcome: { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation: { kind: 'remote_ref', remote: 'origin' }, nextActions: [{ kind: 'refresh' }] } };
        expect(selectLastSuccessfulScmPushAt([committed, uncertain, pushed])).toBe(7);
        expect(selectLastSuccessfulScmPushAt([committed, uncertain])).toBeNull();
        const target = { remote: 'origin', branch: 'v0.3' };
        const targeted: ScmProjectOperationLogEntry = { ...pushed, outcome: { v: 1, kind: 'succeeded', effect: { kind: 'remote', ...target }, nextActions: [] } };
        const anotherBranch: ScmProjectOperationLogEntry = { ...targeted, id: 'other', timestamp: 8, outcome: { v: 1, kind: 'succeeded', effect: { kind: 'remote', remote: 'origin', branch: 'dev' }, nextActions: [] } };
        expect(selectLastSuccessfulScmPushAt([anotherBranch, pushed, targeted], target)).toBe(7);
        expect(selectLastSuccessfulScmPushAt([anotherBranch, pushed], target)).toBeNull();
    });
    it('projects canonical codes without inferring outcome from error prose or current reachability', () => {
        const read = (entry: ScmProjectOperationLogEntry, machineReachable = true) => selectScmWriteOperation({
            inFlight: null, log: [entry], machine: 'Studio Mac', provider: 'GitHub', machineReachable,
        });
        expect(read(failedEntry('REMOTE_NON_FAST_FORWARD', 'rejected'))).toMatchObject({ phase: 'needs_input', outcome: { errorCode: 'REMOTE_NON_FAST_FORWARD' } });
        expect(read(failedEntry('REMOTE_AUTH_REQUIRED', 'authentication required'))).toMatchObject({
            phase: 'needs_input', outcome: { errorCode: 'REMOTE_AUTH_REQUIRED' }, machine: 'Studio Mac', provider: 'GitHub',
        });
        for (const message of ['daemon did not answer', 'Automatic merge failed; fix conflicts', 'fatal: Could not resolve host: github.com']) {
            expect(read(failedEntry('COMMAND_FAILED', message), false)).toMatchObject({ phase: 'failed', outcome: { errorCode: 'COMMAND_FAILED' } });
        }
    });

    it('keeps a terminal result and commit SHA visible after the operation lock clears', () => {
        expect(selectScmWriteOperation({
            inFlight: null,
            log: [{ id: '2', sessionId: 'session', operation: 'commit', status: 'success', timestamp: 2, detail: 'abc123def' }],
            machineReachable: true,
        })).toMatchObject({ phase: 'succeeded', action: 'commit', id: '2', at: 2 });
    });

    it('speaks for the last write the user made, not the refresh or selection bookkeeping that follows it', () => {
        const commit: ScmProjectOperationLogEntry = { id: 'c', sessionId: 'session', operation: 'commit', status: 'success', timestamp: 5, detail: '4f2a91cabc' };
        const log: ScmProjectOperationLogEntry[] = [
            { id: 's', sessionId: 'session', operation: 'stage', status: 'success', timestamp: 7 },
            { id: 'r', sessionId: 'session', operation: 'refresh', status: 'success', timestamp: 6 },
            commit,
        ];
        expect(selectScmWriteOperation({ inFlight: null, log, machineReachable: true }))
            .toMatchObject({ phase: 'succeeded', action: 'commit', id: 'c' });
        // A refresh that failed after a commit is still news.
        expect(selectScmWriteOperation({
            inFlight: null,
            log: [{ id: 'rf', sessionId: 'session', operation: 'refresh', status: 'failed', timestamp: 6, detail: 'boom' }, commit],
            machineReachable: true,
        })).toMatchObject({ phase: 'failed', action: 'refresh', id: 'rf' });
        expect(selectScmWriteOperation({
            inFlight: { id: 'p', sessionId: 'session', operation: 'push', phase: 'running', startedAt: 9 },
            log, machineReachable: true,
        })).toEqual({ phase: 'running', action: 'push', id: 'p', at: 9 });
    });

    it('retains every canonical terminal outcome and its recovery evidence', () => {
        const outcomes: ScmOperationOutcome[] = [
            { v: 1, kind: 'effect_applied_with_warning', errorCode: 'INDEX_RECONCILIATION_FAILED', effect: { kind: 'commit', commitSha: 'abc123' }, nextActions: [{ kind: 'reconcile_index' }] },
            { v: 1, kind: 'conflicted', errorCode: 'CONFLICTING_WORKTREE', repositoryState: { hasConflicts: true, operation: null }, nextActions: [{ kind: 'resolve_conflicts' }] },
            { v: 1, kind: 'cancelled', repositoryState: { hasConflicts: false, operation: null }, nextActions: [] },
            { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_FAILED', reconciliation: { kind: 'remote_ref', remote: 'origin', branch: 'main' }, nextActions: [{ kind: 'refresh' }] },
        ];
        for (const outcome of outcomes) {
            expect(selectScmWriteOperation({ inFlight: null, log: [{ ...failedEntry('COMMAND_FAILED', 'opaque'), outcome }], machineReachable: true })).toMatchObject({ phase: outcome.kind, outcome });
        }
    });
});
