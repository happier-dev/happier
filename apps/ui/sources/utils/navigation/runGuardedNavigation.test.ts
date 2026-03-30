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
});
