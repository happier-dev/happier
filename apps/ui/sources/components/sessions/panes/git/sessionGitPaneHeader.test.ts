import { describe, expect, it } from 'vitest';

import { resolveSessionGitPaneActions, resolveSessionGitPaneHeaderFacts } from './sessionGitPaneHeader';

// Git lab A/S/ST/CF: the header says where you are and the one change count; its trailing action is the
// next sync step (never Commit — the commit form owns that), primary only while no commit is ready.
describe('resolveSessionGitPaneActions', () => {
    const available = [
        { key: 'fetch', disabled: false },
        { key: 'pull', disabled: false },
        { key: 'push', disabled: false },
    ];
    const base = {
        changedCount: 0, ahead: 0, behind: 0, upstream: 'origin/v0.3', hasConflicts: false,
        prState: 'none' as const, prNumber: null, canCreatePr: true, commitReady: false, remoteActions: available,
    };

    it('keeps the sync step in the header while files are changed, secondary only while a commit is ready', () => {
        expect(resolveSessionGitPaneActions({ ...base, changedCount: 14, ahead: 2, commitReady: true }).primary)
            .toEqual({ key: 'push', count: 2, disabled: false, emphasis: 'secondary' });
        expect(resolveSessionGitPaneActions({ ...base, changedCount: 11, ahead: 3 }).primary)
            .toEqual({ key: 'push', count: 3, disabled: false, emphasis: 'primary' });
    });

    it('orders the next step Resolve, Publish, Pull, Push, then the open PR or Up to date', () => {
        expect(resolveSessionGitPaneActions({ ...base, hasConflicts: true, conflictCount: 2, changedCount: 14, commitReady: true }).primary)
            .toMatchObject({ key: 'resolve', count: 2, emphasis: 'primary' });
        expect(resolveSessionGitPaneActions({ ...base, upstream: null, remoteActions: [...available, { key: 'publish', disabled: false }] }).primary)
            .toMatchObject({ key: 'publish', emphasis: 'primary' });
        expect(resolveSessionGitPaneActions({ ...base, ahead: 3, behind: 2 }).primary).toMatchObject({ key: 'pull', count: 2 });
        expect(resolveSessionGitPaneActions({ ...base, ahead: 3 }).primary).toMatchObject({ key: 'push', count: 3 });
        expect(resolveSessionGitPaneActions({ ...base, changedCount: 11 }).primary).toMatchObject({ key: 'up-to-date', emphasis: 'quiet' });
        expect(resolveSessionGitPaneActions({ ...base, prState: 'open', prNumber: 2501 }).primary)
            .toEqual({ key: 'open-pr', count: 2501, disabled: false, emphasis: 'quiet' });
        expect(resolveSessionGitPaneActions({ ...base, prState: 'open', prNumber: null, canCreatePr: false }).primary)
            .toEqual({ key: 'up-to-date', count: null, disabled: true, emphasis: 'quiet' });
    });

    it('keeps a clean branch quiet while pull request creation remains available in the menu', () => {
        const actions = resolveSessionGitPaneActions(base);
        expect(actions.primary).toMatchObject({ key: 'up-to-date', emphasis: 'quiet' });
        expect(actions.menu).toContainEqual({ key: 'create-pr', count: null, disabled: false });
    });

    it('marks the reachable pull recovery after a rejected push as attention, not an ordinary sync primary', () => {
        expect(resolveSessionGitPaneActions({ ...base, ahead: 3, behind: 2, writeOperation: { phase: 'needs_input', action: 'push', id: 'reject', at: 1, message: '', outcome: { v: 1, kind: 'needs_input', errorCode: 'REMOTE_NON_FAST_FORWARD', nextActions: [{ kind: 'choose_reconcile' }] } } }).primary)
            .toMatchObject({ key: 'pull', count: 2, emphasis: 'attention' });
        expect(resolveSessionGitPaneActions({ ...base, behind: 2 }).primary.emphasis).toBe('primary');
    });

    it('never offers an action the backend or policy does not allow, and keeps every alternative in the menu with its state', () => {
        // Ahead, but no push is offered: no button lies about pushing.
        expect(resolveSessionGitPaneActions({ ...base, ahead: 2, canCreatePr: false, remoteActions: [{ key: 'fetch', disabled: false }] }).primary)
            .toMatchObject({ key: 'up-to-date' });
        const offline = resolveSessionGitPaneActions({
            ...base, ahead: 3,
            remoteActions: available.map((action) => ({ ...action, disabled: true })),
        });
        expect(offline.primary).toEqual({ key: 'push', count: 3, disabled: true, emphasis: 'secondary' });
        expect(offline.menu.map((item) => item.key)).toEqual(['push', 'pull', 'fetch', 'create-pr']);
        expect(offline.menu).toContainEqual(expect.objectContaining({ key: 'pull', disabled: true }));
    });
});

describe('resolveSessionGitPaneHeaderFacts', () => {
    it('shows the in-progress repository operation instead of unrelated change counts', () => {
        expect(resolveSessionGitPaneHeaderFacts({ branch: 'v0.3', changedCount: 6, ahead: 3, behind: 2, primaryKey: 'resolve', operation: { kind: 'merge', sourceRef: 'origin/v0.3' } }))
            .toEqual([{ kind: 'branch', branch: 'v0.3' }, { kind: 'operation', operation: 'merge', sourceRef: 'origin/v0.3' }]);
    });
    it('qualifies retained offline branch facts with their actual snapshot read time', () => {
        expect(resolveSessionGitPaneHeaderFacts({ branch: 'v0.3', changedCount: 6, ahead: 3, behind: 2, primaryKey: 'push', asOf: 1234 }))
            .toEqual([{ kind: 'branch', branch: 'v0.3' }, { kind: 'asOf', at: 1234 }]);
    });
    it('states the branch and the change count, and never repeats the number the action carries', () => {
        expect(resolveSessionGitPaneHeaderFacts({ branch: 'v0.3', changedCount: 14, ahead: 2, behind: 0, primaryKey: 'push' }))
            .toEqual([{ kind: 'branch', branch: 'v0.3' }, { kind: 'changed', count: 14 }]);
        expect(resolveSessionGitPaneHeaderFacts({ branch: 'main', changedCount: 0, ahead: 1, behind: 4, primaryKey: 'pull' }))
            .toEqual([{ kind: 'branch', branch: 'main' }, { kind: 'clean' }, { kind: 'toPush', count: 1 }]);
    });
});
