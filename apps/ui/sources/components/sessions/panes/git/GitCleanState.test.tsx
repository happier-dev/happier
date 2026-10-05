import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
const { GitCleanState } = await import('./GitCleanState');

describe('GitCleanState', () => {
    afterEach(() => vi.useRealTimers());
    it('labels a last push only when its timestamp is known, never inferring it from a commit', async () => {
        const props = { branch: 'v0.3', upstream: 'origin/v0.3', ahead: 0, behind: 0, lastCommitAt: 1234, onCreatePullRequest: null, onOpenPullRequest: null, pullRequestNumber: null };
        const unknown = await renderScreen(<GitCleanState {...props} />);
        expect(unknown.getTextContent()).not.toContain('sessionGitPane.fidelity.lastPushed');
        const known = await renderScreen(<GitCleanState {...props} lastPushedAt={2345} justCompleted />);
        expect(known.getTextContent()).toContain('sessionGitPane.fidelity.lastPushed');
        expect(known.getTextContent()).toContain('sessionGitPane.fidelity.allClean');
    });

    it('shows the real latest commit in the finished card and opens that commit before the suggested PR step', async () => {
        vi.useFakeTimers();
        const onOpenCommit = vi.fn();
        const onCreatePullRequest = vi.fn();
        const commit = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Keep the draft', authorName: 'Ana', authorEmail: 'ana@example.com', timestamp: Date.now() - 12 * 60_000, body: '' };
        const screen = await renderScreen(<GitCleanState branch="v0.3" upstream="origin/v0.3" ahead={0} behind={0} lastCommitAt={commit.timestamp} lastCommit={commit} onOpenCommit={onOpenCommit} justCompleted onCreatePullRequest={onCreatePullRequest} onOpenPullRequest={null} pullRequestNumber={null} />);
        expect(screen.getTextContent()).toContain('Keep the draft');
        expect(screen.getTextContent()).toContain('12m');
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(screen.getTextContent()).toContain('13m');
        expect(screen.getTextContent()).toContain('sessionGitPane.fidelity.suggestedNext');
        await screen.pressByTestIdAsync(`scm-commit-entry-${commit.sha}`);
        expect(onOpenCommit).toHaveBeenCalledWith(commit.sha);
        await screen.pressByTestIdAsync('session-git-clean-action');
        expect(onCreatePullRequest).toHaveBeenCalledOnce();
    });
});
