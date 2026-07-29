import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const preventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
    committedEnabled: false,
    committedCallback: null as null | ((event: { data: { action: unknown } }) => void),
}));

vi.mock('@react-navigation/native', () => ({
    usePreventRemove: (
        enabled: boolean,
        callback: (event: { data: { action: unknown } }) => void,
    ) => {
        preventRemove.enabled = enabled;
        preventRemove.callback = callback;
        React.useEffect(() => {
            preventRemove.committedEnabled = enabled;
            preventRemove.committedCallback = callback;
        }, [callback, enabled]);
    },
}));

describe('useUnsavedChangesBeforeRemoveGuard', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        preventRemove.enabled = false;
        preventRemove.callback = null;
        preventRemove.committedEnabled = false;
        preventRemove.committedCallback = null;
    });

    it('registers with the navigator removal owner and continues the blocked action after discard', async () => {
        const action = { type: 'GO_BACK' };
        const isDirtyRef = { current: true };
        const requestDecision = vi.fn(async () => 'discard' as const);
        const onDiscard = vi.fn();
        const onContinue = vi.fn();
        const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');

        await renderHook(() => useUnsavedChangesBeforeRemoveGuard({
            isDirty: true,
            isDirtyRef,
            requestDecision,
            onDiscard,
            onContinue,
            tag: 'useUnsavedChangesBeforeRemoveGuard.test',
        }));

        expect(preventRemove.enabled).toBe(true);
        expect(preventRemove.callback).not.toBeNull();

        await act(async () => {
            preventRemove.callback?.({ data: { action } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(requestDecision).toHaveBeenCalledOnce();
        expect(onDiscard).toHaveBeenCalledOnce();
        expect(onContinue).toHaveBeenCalledWith(action);
        expect(isDirtyRef.current).toBe(false);
    });

    it('disables the navigator removal owner before redispatching a discarded action', async () => {
        const action = { type: 'GO_BACK' };
        const isDirtyRef = { current: true };
        const didNavigate = vi.fn();
        const onContinue = vi.fn((continuedAction: unknown) => {
            expect(continuedAction).toBe(action);
            if (preventRemove.committedEnabled) {
                preventRemove.committedCallback?.({ data: { action: continuedAction } });
                return;
            }
            didNavigate();
        });
        const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');

        await renderHook(() => useUnsavedChangesBeforeRemoveGuard({
            isDirty: true,
            isDirtyRef,
            requestDecision: async () => 'discard',
            onContinue,
            tag: 'useUnsavedChangesBeforeRemoveGuard.redispatch',
        }));

        await act(async () => {
            preventRemove.callback?.({ data: { action } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(onContinue).toHaveBeenCalledOnce();
        expect(didNavigate).toHaveBeenCalledOnce();
        expect(isDirtyRef.current).toBe(false);
    });

    it('serializes repeated removal attempts while one decision is unresolved', async () => {
        let resolveDecision!: (decision: 'keepEditing') => void;
        const requestDecision = vi.fn(() => new Promise<'keepEditing'>((resolve) => {
            resolveDecision = resolve;
        }));
        const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');

        await renderHook(() => useUnsavedChangesBeforeRemoveGuard({
            isDirty: true,
            isDirtyRef: { current: true },
            requestDecision,
            onContinue: vi.fn(),
            tag: 'useUnsavedChangesBeforeRemoveGuard.repeated',
        }));

        await act(async () => {
            preventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
            preventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
            await Promise.resolve();
        });

        expect(requestDecision).toHaveBeenCalledOnce();

        await act(async () => {
            resolveDecision('keepEditing');
            await Promise.resolve();
        });
    });

    it('restores dirty state when continuing a discarded navigator action throws', async () => {
        const isDirtyRef = { current: true };
        const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');

        await renderHook(() => useUnsavedChangesBeforeRemoveGuard({
            isDirty: true,
            isDirtyRef,
            requestDecision: async () => 'discard',
            onContinue: () => {
                throw new Error('dispatch failed');
            },
            tag: 'useUnsavedChangesBeforeRemoveGuard.continueThrows',
        }));

        await act(async () => {
            preventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(isDirtyRef.current).toBe(true);
    });

    it('keeps dirty state when save fails', async () => {
        const isDirtyRef = { current: true };
        const onSave = vi.fn(async () => false);
        const onContinue = vi.fn();
        const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');

        await renderHook(() => useUnsavedChangesBeforeRemoveGuard({
            isDirty: true,
            isDirtyRef,
            requestDecision: async () => 'save',
            onSave,
            onContinue,
            tag: 'useUnsavedChangesBeforeRemoveGuard.saveFails',
        }));

        await act(async () => {
            preventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(onSave).toHaveBeenCalledOnce();
        expect(onContinue).not.toHaveBeenCalled();
        expect(isDirtyRef.current).toBe(true);
    });

    it('blocks a browser unload while dirty and removes the blocker after the draft becomes clean', async () => {
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        type BeforeUnloadHandler = (event: { preventDefault: () => void; returnValue?: string }) => void;
        const beforeUnloadHandlerRef: { current: BeforeUnloadHandler | null } = { current: null };
        const addEventListener = vi.fn((type: string, handler: BeforeUnloadHandler | null) => {
            if (type === 'beforeunload') beforeUnloadHandlerRef.current = handler;
        });
        const removeEventListener = vi.fn((type: string, handler: BeforeUnloadHandler | null) => {
            if (type === 'beforeunload' && beforeUnloadHandlerRef.current === handler) beforeUnloadHandlerRef.current = null;
        });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { addEventListener, removeEventListener },
        });

        try {
            const isDirtyRef = { current: true };
            const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');
            const hook = await renderHook(
                ({ isDirty }: { isDirty: boolean }) => useUnsavedChangesBeforeRemoveGuard({
                    isDirty,
                    isDirtyRef,
                    requestDecision: async () => 'keepEditing',
                    onContinue: vi.fn(),
                    tag: 'useUnsavedChangesBeforeRemoveGuard.browserUnload',
                }),
                { initialProps: { isDirty: true } },
            );

            expect(addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            const preventDefault = vi.fn();
            const event = { preventDefault, returnValue: undefined as string | undefined };
            beforeUnloadHandlerRef.current?.(event);
            expect(preventDefault).toHaveBeenCalledOnce();
            expect(event.returnValue).toBe('');

            isDirtyRef.current = false;
            await hook.rerender({ isDirty: false });
            expect(removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
            expect(beforeUnloadHandlerRef.current).toBeNull();
        } finally {
            if (originalWindowDescriptor) {
                Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'window');
            }
        }
    });

    it('serializes a navigator removal and a concurrent shell exit through one guard lock', async () => {
        const {
            clearActiveUnsavedChangesGuard,
            runGuardedNavigation,
            setActiveUnsavedChangesGuard,
        } = await import('./runGuardedNavigation');
        let resolveDecision!: (decision: 'discard') => void;
        const requestDecision = vi.fn(() => new Promise<'discard'>((resolve) => {
            resolveDecision = resolve;
        }));
        const isDirtyRef = { current: true };
        const navigatorContinue = vi.fn();
        const shellNavigate = vi.fn();
        const { useUnsavedChangesBeforeRemoveGuard } = await import('./useUnsavedChangesBeforeRemoveGuard');

        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            tag: 'useUnsavedChangesBeforeRemoveGuard.mixed.active',
        });
        await renderHook(() => useUnsavedChangesBeforeRemoveGuard({
            isDirty: true,
            isDirtyRef,
            requestDecision,
            onContinue: navigatorContinue,
            tag: 'useUnsavedChangesBeforeRemoveGuard.mixed.navigator',
        }));

        let shellResult: true | Promise<boolean> | undefined;
        await act(async () => {
            preventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
            shellResult = runGuardedNavigation(shellNavigate);
            await Promise.resolve();
        });

        expect(requestDecision).toHaveBeenCalledOnce();
        await expect(shellResult).resolves.toBe(false);

        await act(async () => {
            resolveDecision('discard');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(navigatorContinue).toHaveBeenCalledOnce();
        expect(shellNavigate).not.toHaveBeenCalled();
        clearActiveUnsavedChangesGuard();
    });

});
