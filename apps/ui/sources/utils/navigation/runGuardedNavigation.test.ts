import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

async function loadRunGuardedNavigationModule() {
    return await import(new URL('./runGuardedNavigation.js', import.meta.url).href);
}

describe('runGuardedNavigation', () => {
    afterEach(async () => {
        const { clearActiveUnsavedChangesGuard } = await loadRunGuardedNavigationModule();
        clearActiveUnsavedChangesGuard();
    });

    it('runs navigation immediately when no guard is active', async () => {
        const { clearActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        clearActiveUnsavedChangesGuard();

        const navigate = vi.fn();
        const didNavigate = await runGuardedNavigation(navigate);

        expect(didNavigate).toBe(true);
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('blocks navigation when the user chooses keep editing', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();

        const isDirtyRef = { current: true };
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'keepEditing');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            tag: 'test.keepEditing',
        });

        const didNavigate = await runGuardedNavigation(navigate);

        expect(didNavigate).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(isDirtyRef.current).toBe(true);
    });

    it('discards changes and continues navigation when the user chooses discard', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();

        const isDirtyRef = { current: true };
        const onDiscard = vi.fn();
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'discard');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            onDiscard,
            tag: 'test.discard',
        });

        const didNavigate = await runGuardedNavigation(navigate);

        expect(didNavigate).toBe(true);
        expect(onDiscard).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(false);
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('restores dirty state when discard cleanup throws', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const isDirtyRef = { current: true };
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision: async () => 'discard',
            onDiscard: () => {
                throw new Error('discard failed');
            },
            tag: 'test.discardThrows',
        });

        await expect(runGuardedNavigation(navigate)).resolves.toBe(false);
        expect(isDirtyRef.current).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('restores dirty state when navigation throws after discard', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const isDirtyRef = { current: true };

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision: async () => 'discard',
            tag: 'test.discardNavigationThrows',
        });

        await expect(runGuardedNavigation(() => {
            throw new Error('navigation failed');
        })).resolves.toBe(false);
        expect(isDirtyRef.current).toBe(true);
    });

    it('saves changes and continues navigation when the user chooses save', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();

        const isDirtyRef = { current: true };
        const onSave = vi.fn(async () => true);
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'save');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            onSave,
            tag: 'test.save',
        });

        const didNavigate = await runGuardedNavigation(navigate);

        expect(didNavigate).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(false);
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('lets a successful save own its destination when continuing the original navigation is disabled', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();

        const isDirtyRef = { current: true };
        const onSave = vi.fn(async () => true);
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'save');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            onSave,
            continueOnSave: false,
            tag: 'test.saveOwnsDestination',
        });

        const didComplete = await runGuardedNavigation(navigate);

        expect(didComplete).toBe(true);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does not continue navigation when save fails', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();

        const isDirtyRef = { current: true };
        const onSave = vi.fn(async () => false);
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'save');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            onSave,
            tag: 'test.saveFailed',
        });

        const didNavigate = await runGuardedNavigation(navigate);

        expect(didNavigate).toBe(false);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does not crash when the guard decision prompt throws', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();

        const isDirtyRef = { current: true };
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => {
            throw new Error('prompt failed');
        });
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            tag: 'test.promptThrows',
        });

        await expect(runGuardedNavigation(navigate)).resolves.toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(isDirtyRef.current).toBe(true);
    });

    it('navigates without prompting when the active guard is already clean', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'keepEditing');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: false },
            requestDecision,
            tag: 'test.clean',
        });

        expect(await runGuardedNavigation(navigate)).toBe(true);
        expect(requestDecision).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledOnce();
    });

    it('lets an explicit ignored navigation bypass an in-flight guard', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const isDirtyRef = { current: true };
        const ignoreRef = { current: false };
        let resolveDecision!: (decision: UnsavedChangesDecision) => void;
        const requestDecision = vi.fn(() => new Promise<UnsavedChangesDecision>((resolve) => {
            resolveDecision = resolve;
        }));
        const firstNavigate = vi.fn();
        const ignoredNavigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            ignoreRef,
            requestDecision,
            tag: 'test.ignoreInFlight',
        });

        const firstExit = runGuardedNavigation(firstNavigate);
        ignoreRef.current = true;

        expect(await runGuardedNavigation(ignoredNavigate)).toBe(true);
        expect(ignoredNavigate).toHaveBeenCalledOnce();
        expect(requestDecision).toHaveBeenCalledOnce();

        resolveDecision('keepEditing');
        expect(await firstExit).toBe(false);
        expect(firstNavigate).not.toHaveBeenCalled();
    });

    it('serializes repeated shell exits through the active guard', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        let resolveDecision!: (decision: UnsavedChangesDecision) => void;
        const requestDecision = vi.fn(() => new Promise<UnsavedChangesDecision>((resolve) => {
            resolveDecision = resolve;
        }));
        const firstNavigate = vi.fn();
        const secondNavigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'test.repeatedShell',
        });

        const firstExit = runGuardedNavigation(firstNavigate);
        const secondExit = runGuardedNavigation(secondNavigate);

        expect(requestDecision).toHaveBeenCalledOnce();
        await expect(secondExit).resolves.toBe(false);

        resolveDecision('discard');
        await expect(firstExit).resolves.toBe(true);
        expect(firstNavigate).toHaveBeenCalledOnce();
        expect(secondNavigate).not.toHaveBeenCalled();
    });

    it('keeps a second exit blocked while a discarded continuation is still in flight', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const isDirtyRef = { current: true };
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'discard');
        let resolveFirstNavigation!: () => void;
        let markFirstNavigationStarted!: () => void;
        const firstNavigationStarted = new Promise<void>((resolve) => {
            markFirstNavigationStarted = resolve;
        });
        const firstNavigate = vi.fn(() => new Promise<void>((resolve) => {
            resolveFirstNavigation = resolve;
            markFirstNavigationStarted();
        }));
        const secondNavigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            tag: 'test.repeatedShellDuringContinuation',
        });

        const firstExit = runGuardedNavigation(firstNavigate);
        await firstNavigationStarted;
        expect(isDirtyRef.current).toBe(false);

        const secondExit = runGuardedNavigation(secondNavigate);

        expect(requestDecision).toHaveBeenCalledOnce();
        expect(await secondExit).toBe(false);
        expect(firstNavigate).toHaveBeenCalledOnce();
        expect(secondNavigate).not.toHaveBeenCalled();

        resolveFirstNavigation();
        await expect(firstExit).resolves.toBe(true);

        const thirdNavigate = vi.fn();
        expect(await runGuardedNavigation(thirdNavigate)).toBe(true);
        expect(thirdNavigate).toHaveBeenCalledOnce();
    });
});
