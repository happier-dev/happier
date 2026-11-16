import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { installTimerCensus, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { NEW_SESSION_WORKTREE_STALE_THRESHOLD_MS } from './_constants';

installNewSessionScreenModelCommonModuleMocks();
installDisconnectedServerSocketBoundary();

const { useCheckoutSelectionPicker } = await import('./useCheckoutSelectionPicker');

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function makeSnapshot(lastActivityAt = Date.now() - 60_000): ScmWorkingSnapshot {
    return {
        projectKey: 'picker:/repo', fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [
            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            { path: '/repo/other', branch: 'other', isCurrent: false, lastActivityAt, changeCount: 0 },
        ] },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0,
            includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
}

it('keeps folder and step workspace choices available without a Git repository', async () => {
    const snapshot = makeSnapshot();
    const sameAsWorkflow = vi.fn();
    const fromStep = vi.fn();
    const currentDirectory = vi.fn();
    const hook = await renderHook(() => useCheckoutSelectionPicker({
        repoScmSnapshot: { ...snapshot, repo: { ...snapshot.repo, isRepo: false, worktrees: [] } },
        checkoutChipModel: { selectedOptionId: 'current_path', options: [
            { id: 'current_path', kind: 'current_path', path: '/folder' },
        ] },
        selectedMachineId: 'picker-machine', selectedPath: '/folder', onSelectCheckoutPath: currentDirectory,
        workflowScope: {
            newWorktree: { onSelect: vi.fn() },
            step: { sameAsWorkflow: { subtitle: '/folder', onSelect: sameAsWorkflow },
                fromSteps: [{ blockId: 'producer', label: 'Prepare folder', onSelect: fromStep }] },
        },
    }));
    try {
        const picker = hook.getCurrent();
        expect(picker).not.toBeNull();
        const options = picker!.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(options.map(option => option.id)).toEqual([
            'workspace_same_as_workflow', 'workspace_from_step:producer', 'current_path',
        ]);
        options.find(option => option.id === 'workspace_same_as_workflow')!.onSelect?.();
        options.find(option => option.id === 'workspace_from_step:producer')!.onSelect?.();
        options.find(option => option.id === 'current_path')!.onSelect?.();
        expect(sameAsWorkflow).toHaveBeenCalledOnce();
        expect(fromStep).toHaveBeenCalledOnce();
        expect(currentDirectory).toHaveBeenCalledWith('/folder');
    } finally { await hook.unmount(); }
});

it('does no settled clock work for unrendered checkout labels', async () => {
    vi.useFakeTimers();
    const census = installTimerCensus();
    const requests = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected closed-picker request'));
    const repoScmSnapshot = makeSnapshot();
    let renders = 0;
    const hook = await renderHook(() => {
        renders += 1;
        return useCheckoutSelectionPicker({
            repoScmSnapshot,
            checkoutChipModel: { selectedOptionId: 'current_path', options: [
                { id: 'current_path', kind: 'current_path', path: '/repo' },
            ] },
            selectedMachineId: 'picker-machine', selectedPath: '/repo', onSelectCheckoutPath: () => {},
        });
    }, { flushOptions: { cycles: 1, turns: 0 } });
    try {
        expect(hook.getCurrent()).not.toBeNull();
        const before = renders;
        await React.act(async () => { vi.advanceTimersByTime(180_000); });
        expect(census.readFires()).toEqual({ timeout: 0, interval: 0 });
        expect(renders - before).toBe(0);
        expect(requests).not.toHaveBeenCalled();
        expect(census.read()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        await hook.unmount();
        census.stop();
    }
});

it('keeps mounted labels fresh without rebuilding the picker and retires their clock while unpresented', async () => {
    vi.useFakeTimers();
    const census = installTimerCensus();
    const lastActivityAt = Date.now() - 30_000;
    const repoScmSnapshot = makeSnapshot(lastActivityAt);
    const hook = await renderHook(() => useCheckoutSelectionPicker({
        repoScmSnapshot,
        checkoutChipModel: { selectedOptionId: 'current_path', options: [
            { id: 'current_path', kind: 'current_path', path: '/repo' },
        ] },
        selectedMachineId: 'picker-machine', selectedPath: '/repo', onSelectCheckoutPath: () => {},
    }), { flushOptions: { cycles: 1, turns: 0 } });
    const rootStep = hook.getCurrent()!.rootStep;
    const section = rootStep.sections.find(section => section.id === 'worktree:existing');
    if (section?.kind !== 'static') throw new Error('Expected existing worktrees');
    const accessory = section.options[0]!.rightAccessory;
    if (!React.isValidElement(accessory)) throw new Error('Expected worktree details');
    const view = (active: boolean) => React.createElement(PluginSurfaceFocusEligibilityProvider, { active, children: accessory });
    const screen = await renderScreen(view(true));
    try {
        expect(screen.getTextContent()).toContain(formatRelativeTimeShort(lastActivityAt, Date.now()));
        await React.act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getTextContent()).toContain(formatRelativeTimeShort(lastActivityAt, Date.now()));
        expect(census.readFires()).toEqual({ timeout: 1, interval: 0 });
        expect(hook.getCurrent()!.rootStep).toBe(rootStep);

        await screen.update(view(false));
        expect(vi.getTimerCount()).toBe(0);
        await React.act(async () => { vi.advanceTimersByTime(180_000); });
        expect(census.readFires()).toEqual({ timeout: 1, interval: 0 });
        await screen.update(view(true));
        expect(screen.getTextContent()).toContain(formatRelativeTimeShort(lastActivityAt, Date.now()));
        expect(hook.getCurrent()!.rootStep).toBe(rootStep);
    } finally {
        await screen.unmount();
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
        census.stop();
    }
});

it('updates a rendered clean worktree at its strict stale-status deadline', async () => {
    vi.useFakeTimers();
    const repoScmSnapshot = makeSnapshot(Date.now() - NEW_SESSION_WORKTREE_STALE_THRESHOLD_MS + 60_000);
    const hook = await renderHook(() => useCheckoutSelectionPicker({
        repoScmSnapshot,
        checkoutChipModel: { selectedOptionId: 'current_path', options: [
            { id: 'current_path', kind: 'current_path', path: '/repo' },
        ] },
        selectedMachineId: 'picker-machine', selectedPath: '/repo', onSelectCheckoutPath: () => {},
    }), { flushOptions: { cycles: 1, turns: 0 } });
    const section = hook.getCurrent()!.rootStep.sections.find(section => section.id === 'worktree:existing');
    if (section?.kind !== 'static') throw new Error('Expected existing worktrees');
    const accessory = section.options[0]!.rightAccessory;
    if (!React.isValidElement(accessory)) throw new Error('Expected worktree details');
    const screen = await renderScreen(accessory);
    try {
        expect(screen.findHostByTestId('worktree-row-status:/repo/other:variant:clean')).not.toBeNull();
        await React.act(async () => { vi.advanceTimersByTime(60_000); });
        expect(screen.findHostByTestId('worktree-row-status:/repo/other:variant:clean')).not.toBeNull();
        await React.act(async () => { vi.advanceTimersByTime(1); });
        expect(screen.findHostByTestId('worktree-row-status:/repo/other:variant:stale')).not.toBeNull();
    } finally {
        await screen.unmount();
        await hook.unmount();
    }
});
