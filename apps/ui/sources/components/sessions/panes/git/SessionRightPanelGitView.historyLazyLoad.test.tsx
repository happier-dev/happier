import { describe, expect, it } from 'vitest';

import { shouldLoadSessionGitHistory } from './shouldLoadSessionGitHistory';

describe('shouldLoadSessionGitHistory', () => {
    it('defers history loading until the History subtab is active', () => {
        expect(shouldLoadSessionGitHistory({
            activeSubTab: 'commit',
            sessionPath: '/repo',
            commitHistoryInitKey: 's1:/repo',
            loadedCommitHistoryInitKey: null,
        })).toBe(false);
    });

    it('loads history once when the History subtab is active for a session path', () => {
        expect(shouldLoadSessionGitHistory({
            activeSubTab: 'history',
            sessionPath: '/repo',
            commitHistoryInitKey: 's1:/repo',
            loadedCommitHistoryInitKey: null,
        })).toBe(true);

        expect(shouldLoadSessionGitHistory({
            activeSubTab: 'history',
            sessionPath: '/repo',
            commitHistoryInitKey: 's1:/repo',
            loadedCommitHistoryInitKey: 's1:/repo',
        })).toBe(false);
    });

    it('does not load history before the session path is known', () => {
        expect(shouldLoadSessionGitHistory({
            activeSubTab: 'history',
            sessionPath: null,
            commitHistoryInitKey: 's1:',
            loadedCommitHistoryInitKey: null,
        })).toBe(false);
    });
});
