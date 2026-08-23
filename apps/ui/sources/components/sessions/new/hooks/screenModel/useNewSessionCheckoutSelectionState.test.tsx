import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { useNewSessionCheckoutSelectionState } from './useNewSessionCheckoutSelectionState';

vi.mock('@/utils/worktree/generateWorktreeName', () => ({
    generateWorktreeName: () => 'calm-forest',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookParams = Parameters<typeof useNewSessionCheckoutSelectionState>[0];

function makeRepoSnapshot(backendId: 'git' | 'svn' = 'git'): ScmWorkingSnapshot {
    return {
        projectKey: 'machine-1:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId,
            mode: '.git',
            worktrees: [],
        },
        capabilities: {},
        branch: null,
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    } as ScmWorkingSnapshot;
}

function makeParams(overrides: Partial<HookParams> = {}): HookParams {
    return {
        persistedDraft: null,
        selectedMachineId: 'machine-1',
        selectedPath: '/repo',
        repoScmSnapshot: makeRepoSnapshot(),
        defaultCheckoutMode: 'git_worktree',
        ...overrides,
    };
}

describe('useNewSessionCheckoutSelectionState', () => {
    it('preserves an explicit current-path override after clearing a hydrated worktree draft', async () => {
        const hydratedDraft = {
            kind: 'git_worktree' as const,
            displayName: 'hydrated-worktree',
            baseRef: 'main',
            branchMode: 'new' as const,
        };
        const hook = await renderHook(() => useNewSessionCheckoutSelectionState(makeParams({
            persistedDraft: { checkoutCreationDraft: hydratedDraft },
        })));

        expect(hook.getCurrent().checkoutCreationDraft).toEqual(hydratedDraft);

        await act(async () => {
            hook.getCurrent().setCheckoutCreationDraft(null);
        });
        await flushHookEffects();

        expect(hook.getCurrent().checkoutCreationDraft).toBeNull();
        await hook.unmount();
    });

    it('treats a persisted explicit null as a current-path selection instead of an unset default', async () => {
        const hook = await renderHook(() => useNewSessionCheckoutSelectionState(makeParams({
            persistedDraft: { checkoutCreationDraft: null },
        })));

        await flushHookEffects();

        expect(hook.getCurrent().checkoutCreationDraft).toBeNull();
        await hook.unmount();
    });

    it('lets an explicit temp current-path selection override a persisted worktree', async () => {
        const hook = await renderHook(() => useNewSessionCheckoutSelectionState(makeParams({
            tempSessionData: { checkoutCreationDraft: null },
            persistedDraft: {
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'persisted-worktree',
                    baseRef: 'main',
                },
            },
        })));

        await flushHookEffects();

        expect(hook.getCurrent().checkoutCreationDraft).toBeNull();
        await hook.unmount();
    });

    it('preserves an explicit current-path selection that arrives with delayed Git detection', async () => {
        const hook = await renderHook(
            (props: HookParams) => useNewSessionCheckoutSelectionState(props),
            { initialProps: makeParams({ repoScmSnapshot: makeRepoSnapshot('svn') }) },
        );

        expect(hook.getCurrent().checkoutCreationDraft).toBeNull();

        await hook.rerender(makeParams({
            tempSessionData: { checkoutCreationDraft: null },
            repoScmSnapshot: makeRepoSnapshot('git'),
        }));
        await flushHookEffects();

        expect(hook.getCurrent().checkoutCreationDraft).toBeNull();
        await hook.unmount();
    });

    it('applies the worktree default when delayed repository detection becomes Git', async () => {
        const initialProps = makeParams({ repoScmSnapshot: makeRepoSnapshot('svn') });
        const hook = await renderHook(
            (props: HookParams) => useNewSessionCheckoutSelectionState(props),
            { initialProps },
        );

        expect(hook.getCurrent().checkoutCreationDraft).toBeNull();

        await hook.rerender(makeParams({ repoScmSnapshot: makeRepoSnapshot('git') }));
        await flushHookEffects();

        expect(hook.getCurrent().checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'calm-forest',
            baseRef: null,
            branchMode: 'new',
        });
        await hook.unmount();
    });
});
