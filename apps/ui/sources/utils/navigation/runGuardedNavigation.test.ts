import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

async function loadRunGuardedNavigationModule() {
    return await import(new URL('./runGuardedNavigation.js', import.meta.url).href);
}

describe('runGuardedNavigation', () => {
    it('preserves a dirty editor across its internal Back and still guards the next departure', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const isDirtyRef = { current: true };
        let hasStep = true;
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'keepEditing');
        const navigate = vi.fn();
        setActiveUnsavedChangesGuard({ isDirtyRef, requestDecision, tag: 'preserving-page-back',
            canLeaveHistoryWithoutDiscard: () => hasStep,
            onHistoryLeave: async () => { hasStep = false; expect(await runGuardedNavigation(navigate)).toBe(true); } });
        expect(await runGuardedNavigation(navigate, 'history')).toBe(true);
        expect(navigate).toHaveBeenCalledOnce();
        expect(requestDecision).not.toHaveBeenCalled();
        expect(isDirtyRef.current).toBe(true);
        expect(await runGuardedNavigation(navigate, 'history')).toBe(false);
        expect(isDirtyRef.current).toBe(true);
        expect(requestDecision).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledOnce();
    });

    it('keeps an editor mounted when preparation rejects and permits a later confirmed retry', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        let confirmed = false;
        const isDirtyRef = { current: false };
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'discard');
        setActiveUnsavedChangesGuard({ isDirtyRef, requestDecision, tag: 'unconfirmed-flush',
            prepareGuard: async () => { if (!confirmed) throw new Error('snapshot_unconfirmed'); } });
        const navigate = vi.fn();
        expect(await runGuardedNavigation(navigate)).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(requestDecision).not.toHaveBeenCalled();
        confirmed = true;
        expect(await runGuardedNavigation(navigate)).toBe(true);
        expect(navigate).toHaveBeenCalledOnce();
    });

    it('blocks another departure during preparation and prepares the next independent intent again', async () => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        let finish!: () => void;
        const prepareGuard = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
            .mockResolvedValue(undefined);
        const navigate = vi.fn();
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: false }, prepareGuard,
            requestDecision: async () => 'keepEditing', tag: 'pending-prepare' });
        const first = runGuardedNavigation(navigate);
        expect(await runGuardedNavigation(navigate)).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        finish();
        expect(await first).toBe(true);
        expect(await runGuardedNavigation(navigate)).toBe(true);
        expect(prepareGuard).toHaveBeenCalledTimes(2);
        expect(navigate).toHaveBeenCalledTimes(2);
    });

    it.each(['clean', 'discard', 'save', 'cancel'] as const)('admits a prepared %s continuation through a nested navigation owner', async decision => {
        const { setActiveUnsavedChangesGuard, runGuardedNavigation } = await loadRunGuardedNavigationModule();
        const isDirtyRef = { current: false };
        const prepareGuard = vi.fn(() => { isDirtyRef.current = decision !== 'clean'; });
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => decision === 'cancel' ? 'keepEditing' : decision === 'clean' ? 'keepEditing' : decision);
        setActiveUnsavedChangesGuard({ isDirtyRef, prepareGuard, requestDecision, onSave: () => true, tag: 'prepared-nested' });
        const navigate = vi.fn();
        let admitted: boolean | undefined;
        const result = await runGuardedNavigation(async () => { admitted = await runGuardedNavigation(navigate); });
        expect(result).toBe(decision !== 'cancel');
        expect(navigate).toHaveBeenCalledTimes(decision === 'cancel' ? 0 : 1);
        expect(admitted).toBe(decision === 'cancel' ? undefined : true);
        expect(prepareGuard).toHaveBeenCalledOnce();
        expect(requestDecision).toHaveBeenCalledTimes(decision === 'clean' ? 0 : 1);
    });

    const retireMountedGuards: (() => void)[] = [];
    afterEach(async () => {
        retireMountedGuards.splice(0).forEach(retire => retire());
        const { clearActiveUnsavedChangesGuard } = await loadRunGuardedNavigationModule();
        clearActiveUnsavedChangesGuard();
    });

    it('retires a held close when a different mounted editor acquires the same tab', async () => {
        const { registerMountedTabUnsavedChangesGuard, runGuardedTabNavigation } = await loadRunGuardedNavigationModule();
        let resolveDecision!: (decision: UnsavedChangesDecision) => void;
        const oldGuard = { isDirtyRef: { current: true }, tag: 'retired-editor',
            onDiscard: vi.fn(),
            requestDecision: () => new Promise<UnsavedChangesDecision>(resolve => { resolveDecision = resolve; }) };
        const retire = registerMountedTabUnsavedChangesGuard('tab', oldGuard);
        retireMountedGuards.push(retire);
        const navigate = vi.fn();
        const pending = runGuardedTabNavigation(['tab'], navigate);
        await Promise.resolve();
        retire();
        const replacement = { isDirtyRef: { current: true }, tag: 'replacement-editor',
            requestDecision: vi.fn(async (): Promise<UnsavedChangesDecision> => 'keepEditing') };
        retireMountedGuards.push(registerMountedTabUnsavedChangesGuard('tab', replacement));
        resolveDecision('discard');
        expect(await pending).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(oldGuard.isDirtyRef.current).toBe(true);
        expect(oldGuard.onDiscard).not.toHaveBeenCalled();
        expect(replacement.isDirtyRef.current).toBe(true);
    });

    it.each(['throws', 'refuses'] as const)('applies batch discard effects only after admission and restores protection if final navigation %s', async failure => {
        const { registerMountedTabUnsavedChangesGuard, runGuardedTabNavigation } = await loadRunGuardedNavigationModule();
        const ignoreRef = { current: false };
        const first = { isDirtyRef: { current: true }, ignoreRef, tag: 'first-editor',
            requestDecision: async (): Promise<UnsavedChangesDecision> => 'discard',
            onDiscard: vi.fn(() => { ignoreRef.current = true; }) };
        let current = true;
        const second = { isDirtyRef: { current: true }, tag: 'second-editor',
            requestDecision: async (): Promise<UnsavedChangesDecision> => {
                expect(first.isDirtyRef.current).toBe(true);
                expect(first.onDiscard).not.toHaveBeenCalled();
                current = false;
                return 'discard';
            } };
        retireMountedGuards.push(registerMountedTabUnsavedChangesGuard('first', first), registerMountedTabUnsavedChangesGuard('second', second));
        const navigate = vi.fn(() => {
            if (failure === 'throws') throw new Error('navigation failed');
            return false;
        });
        expect(await runGuardedTabNavigation(['first', 'second'], navigate, { isCurrent: () => current })).toBe(false);
        expect(first.isDirtyRef.current).toBe(true);
        expect(second.isDirtyRef.current).toBe(true);
        expect(first.onDiscard).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(await runGuardedTabNavigation(['first'], navigate)).toBe(false);
        expect(first.onDiscard).toHaveBeenCalledOnce();
        expect(first.isDirtyRef.current).toBe(true);
        expect(ignoreRef.current).toBe(false);
        const departed = vi.fn(() => {
            expect(first.isDirtyRef.current).toBe(false);
            expect(ignoreRef.current).toBe(true);
        });
        expect(await runGuardedTabNavigation(['first'], departed)).toBe(true);
        expect(departed).toHaveBeenCalledOnce();
    });

    it('keeps earlier discard decisions protective when a later save owns its departure', async () => {
        const { registerMountedTabUnsavedChangesGuard, runGuardedTabNavigation } = await loadRunGuardedNavigationModule();
        const first = { isDirtyRef: { current: true }, tag: 'retained-editor',
            requestDecision: async (): Promise<UnsavedChangesDecision> => 'discard', onDiscard: vi.fn() };
        const second = { isDirtyRef: { current: true }, tag: 'saved-editor', continueOnSave: false,
            requestDecision: async (): Promise<UnsavedChangesDecision> => 'save', onSave: async () => true };
        retireMountedGuards.push(registerMountedTabUnsavedChangesGuard('first', first), registerMountedTabUnsavedChangesGuard('second', second));
        const navigate = vi.fn();
        expect(await runGuardedTabNavigation(['first', 'second'], navigate)).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
        expect(first.onDiscard).not.toHaveBeenCalled();
        expect(first.isDirtyRef.current).toBe(true);
        expect(second.isDirtyRef.current).toBe(false);
    });

    it.each(['keepEditing', 'refuses', 'throws'] as const)('rearms a saved surviving editor when batch navigation %s', async failure => {
        const { registerMountedTabUnsavedChangesGuard, runGuardedTabNavigation } = await loadRunGuardedNavigationModule();
        const ignoreRef = { current: false };
        const first = { isDirtyRef: { current: true }, ignoreRef, tag: 'saved-retained-editor',
            requestDecision: vi.fn(async (): Promise<UnsavedChangesDecision> => 'save'),
            onSave: async () => { ignoreRef.current = true; return true; } };
        const second = { isDirtyRef: { current: true }, tag: 'later-editor',
            requestDecision: async (): Promise<UnsavedChangesDecision> => failure === 'keepEditing' ? 'keepEditing' : 'discard' };
        retireMountedGuards.push(registerMountedTabUnsavedChangesGuard('first', first), registerMountedTabUnsavedChangesGuard('second', second));
        const navigate = vi.fn(() => {
            if (failure === 'throws') throw new Error('navigation failed');
            return false;
        });
        expect(await runGuardedTabNavigation(['first', 'second'], navigate)).toBe(false);
        expect(first.isDirtyRef.current).toBe(false);
        expect(ignoreRef.current).toBe(false);
        first.isDirtyRef.current = true;
        first.requestDecision.mockResolvedValue('keepEditing');
        expect(await runGuardedTabNavigation(['first'], navigate)).toBe(false);
        expect(first.requestDecision).toHaveBeenCalledTimes(2);
    });

    it.each(['keepEditing', 'save'] as const)('restores a surviving editor when a later editor refuses with %s', async decision => {
        const { registerMountedTabUnsavedChangesGuard, runGuardedTabNavigation, setActiveUnsavedChangesGuard } = await loadRunGuardedNavigationModule();
        const ignoreRef = { current: false };
        const first = { isDirtyRef: { current: true }, ignoreRef, tag: 'first-editor',
            onDiscard: vi.fn(() => { ignoreRef.current = true; }),
            requestDecision: vi.fn(async (): Promise<UnsavedChangesDecision> => 'discard') };
        const second = { isDirtyRef: { current: true }, tag: 'second-editor',
            requestDecision: vi.fn(async (): Promise<UnsavedChangesDecision> => decision), onSave: async () => false };
        retireMountedGuards.push(registerMountedTabUnsavedChangesGuard('first', first), registerMountedTabUnsavedChangesGuard('second', second));
        setActiveUnsavedChangesGuard(first);
        const navigate = vi.fn();
        expect(await runGuardedTabNavigation(['first', 'second'], navigate, { includeActiveGuard: true })).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        expect(first.requestDecision).toHaveBeenCalledOnce();
        expect(first.isDirtyRef.current).toBe(true);
        expect(ignoreRef.current).toBe(false);
        expect(first.onDiscard).not.toHaveBeenCalled();
        expect(second.isDirtyRef.current).toBe(true);
        first.requestDecision.mockResolvedValue('keepEditing');
        expect(await runGuardedTabNavigation(['first'], navigate)).toBe(false);
        expect(first.requestDecision).toHaveBeenCalledTimes(2);
        expect(navigate).not.toHaveBeenCalled();
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
        const ignoreRef = { current: false };

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            ignoreRef,
            requestDecision: async () => 'discard',
            onDiscard: () => { ignoreRef.current = true; },
            tag: 'test.discardNavigationThrows',
        });

        await expect(runGuardedNavigation(() => {
            throw new Error('navigation failed');
        })).resolves.toBe(false);
        expect(isDirtyRef.current).toBe(true);
        expect(ignoreRef.current).toBe(false);
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
        const ignoreRef = { current: false };
        const onSave = vi.fn(async () => { ignoreRef.current = true; isDirtyRef.current = false; return false; });
        const requestDecision = vi.fn(async (): Promise<UnsavedChangesDecision> => 'save');
        const navigate = vi.fn();

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            ignoreRef,
            requestDecision,
            onSave,
            tag: 'test.saveFailed',
        });

        const didNavigate = await runGuardedNavigation(navigate);

        expect(didNavigate).toBe(false);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(true);
        expect(ignoreRef.current).toBe(false);
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
        let markDecisionStarted!: () => void;
        const decisionStarted = new Promise<void>((resolve) => { markDecisionStarted = resolve; });
        const requestDecision = vi.fn(() => new Promise<UnsavedChangesDecision>((resolve) => {
            resolveDecision = resolve;
            markDecisionStarted();
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

        await decisionStarted;
        expect(requestDecision).toHaveBeenCalledOnce();
        await expect(secondExit).resolves.toBe(false);

        resolveDecision('discard');
        await expect(firstExit).resolves.toBe(true);
        expect(firstNavigate).toHaveBeenCalledOnce();
        expect(secondNavigate).not.toHaveBeenCalled();
    });

    it('allows clean navigation during an accepted discard continuation without prompting again', async () => {
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
        expect(await secondExit).toBe(true);
        expect(firstNavigate).toHaveBeenCalledOnce();
        expect(secondNavigate).toHaveBeenCalledOnce();

        resolveFirstNavigation();
        await expect(firstExit).resolves.toBe(true);

        const thirdNavigate = vi.fn();
        expect(await runGuardedNavigation(thirdNavigate)).toBe(true);
        expect(thirdNavigate).toHaveBeenCalledOnce();
    });
});
