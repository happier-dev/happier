import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { scmComparisonKey } from './filesComparison';
import { useScmReviewActiveFileSelection, useScmReviewModelChoice } from './useSessionScmReviewTabState';
import { useAppPaneContext, type AppPaneContextValue } from '@/components/appShell/panes/AppPaneContext';
import {
    activeReviewFileKeyForSession,
    publishActiveReviewFile,
    readActiveReviewFile,
    resetActiveReviewFilesForTests,
    subscribeActiveReviewFile,
} from '@/components/workspaces/scm/review/activeReviewFile';

describe('review selection restoration', () => {
    afterEach(async () => {
        await standardCleanup();
        resetActiveReviewFilesForTests();
        replacePersistentUiStateForTest(paneUiState, {});
    });

    it('scopes model drafts to their host and preference without subscribing to unrelated pane changes', async () => {
        let dispatch!: AppPaneContextValue['dispatch'];
        let renders = 0;
        function DispatchProbe() { dispatch = useAppPaneContext(value => value.dispatch); return null; }
        function Wrapper({ children }: PropsWithChildren) {
            return <AppPaneProvider><DispatchProbe />{children}</AppPaneProvider>;
        }
        const hook = await renderHook(({ host, preference }: { host: string; preference: string | null }) => {
            renders++;
            return useScmReviewModelChoice(host, preference, 'session:model-draft');
        }, { initialProps: { host: 'home/account/comparison/walkthrough', preference: null }, wrapper: Wrapper });
        await act(async () => hook.getCurrent().setModel('explicit-model'));
        expect(hook.getCurrent().chosenModel).toBe('explicit-model');
        renders = 0;
        await act(async () => dispatch({ type: 'patchDetailsTabState', scopeId: 'another-pane', tabKey: 'file:a', patch: { scrollTop: 100 } }));
        expect(renders).toBe(0);
        await hook.rerender({ host: 'another-account/comparison/walkthrough', preference: null });
        expect(hook.getCurrent().chosenModel).toBeNull();
        await hook.rerender({ host: 'home/account/comparison/walkthrough', preference: 'new-account-preference' });
        expect(hook.getCurrent().chosenModel).toBeNull();
    });

    it('does not broadcast a tab restoration as a Session-wide comparison navigation', async () => {
        const comparison = { kind: 'branch', head: 'master', base: '0968584' } as const;
        const key = activeReviewFileKeyForSession('session', 'home');
        const navigationNotification = vi.fn();
        const unsubscribe = subscribeActiveReviewFile(key, navigationNotification);
        const hook = await renderHook(({ presented }: { presented: boolean }) => {
            const pane = useAppPaneScope('session:restore-branch');
            return useScmReviewActiveFileSelection({
                pane, hostKey: 'host', activeFileKey: key, comparison, view: 'files', presented,
                persistedSelection: { selectionKey: JSON.stringify(['host', scmComparisonKey(comparison)]), path: 'turn-one.txt' },
            });
        }, { initialProps: { presented: true }, wrapper: AppPaneProvider });

        expect(readActiveReviewFile(key).focusRequest).toBeNull();
        expect(readActiveReviewFile(hook.getCurrent().key).focusRequest).toMatchObject({ path: 'turn-one.txt', comparison });
        expect(navigationNotification).not.toHaveBeenCalled();
        await hook.rerender({ presented: false });
        await hook.rerender({ presented: true });
        expect(readActiveReviewFile(key).focusRequest).toBeNull();
        expect(readActiveReviewFile(hook.getCurrent().key).focusRequest).toMatchObject({ path: 'turn-one.txt', comparison });
        expect(navigationNotification).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('keeps another comparison’s file and subscribers unchanged when a retained review is presented again', async () => {
        const key = activeReviewFileKeyForSession('session', 'home');
        const branch = { kind: 'branch', head: 'master', base: '0968584' } as const;
        const session = { kind: 'session' } as const;
        const hook = await renderHook(({ presented }: { presented: boolean }) => {
            const branchPane = useAppPaneScope('session:branch');
            const sessionPane = useAppPaneScope('session:session');
            return {
                branch: useScmReviewActiveFileSelection({ pane: branchPane, hostKey: 'host', activeFileKey: key,
                    comparison: branch, view: 'files', presented: true }),
                session: useScmReviewActiveFileSelection({ pane: sessionPane, hostKey: 'host', activeFileKey: key,
                    comparison: session, view: 'files', presented,
                    persistedSelection: { selectionKey: JSON.stringify(['host', scmComparisonKey(session)]), path: 'other.txt' } }),
            };
        }, { initialProps: { presented: false }, wrapper: AppPaneProvider });
        const branchKey = hook.getCurrent().branch.key;
        await act(async () => publishActiveReviewFile(branchKey, { presented: true, activePath: 'turn-one.txt' }));
        const branchState = readActiveReviewFile(branchKey);
        const unrelatedNotification = vi.fn();
        const unsubscribe = subscribeActiveReviewFile(branchKey, unrelatedNotification);

        await hook.rerender({ presented: true });
        expect(hook.getCurrent().session.key).not.toBe(branchKey);
        expect(readActiveReviewFile(branchKey)).toBe(branchState);
        expect(readActiveReviewFile(hook.getCurrent().session.key).focusRequest?.path).toBe('other.txt');
        expect(unrelatedNotification).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('restores once per mounted Files view, without a new scroll request on retained return', async () => {
        const comparison = { kind: 'workingTree' } as const;
        const key = activeReviewFileKeyForSession('retained-return', 'home');
        const hook = await renderHook(({ presented, view }: { presented: boolean; view: 'files' | 'walkthrough' }) => {
            const pane = useAppPaneScope('session:retained-return');
            return useScmReviewActiveFileSelection({ pane, hostKey: 'host', activeFileKey: key, comparison, view, presented,
                persistedSelection: { selectionKey: JSON.stringify(['host', scmComparisonKey(comparison)]), path: 'last.txt' } });
        }, { initialProps: { presented: true, view: 'files' }, wrapper: AppPaneProvider });
        const restored = readActiveReviewFile(hook.getCurrent().key).focusRequest;
        expect(restored?.path).toBe('last.txt');
        let requests = 0;
        const unsubscribe = subscribeActiveReviewFile(hook.getCurrent().key, () => { requests += 1; });
        try {
            await hook.rerender({ presented: false, view: 'files' });
            await hook.rerender({ presented: true, view: 'files' });
            expect(requests, 'retained rows already own their scroll position').toBe(0);
            expect(readActiveReviewFile(hook.getCurrent().key).focusRequest).toBe(restored);
            await hook.rerender({ presented: true, view: 'walkthrough' });
            await hook.rerender({ presented: true, view: 'files' });
            expect(requests, 'a retired Files body needs its saved selection restored').toBe(1);
            expect(readActiveReviewFile(hook.getCurrent().key).focusRequest?.nonce).not.toBe(restored?.nonce);
        } finally { unsubscribe(); }
    });
});
