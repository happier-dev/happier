import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { AlertButton } from '@/modal/types';

const boundary = vi.hoisted(() => ({
    buttons: [] as AlertButton[],
    preventRemove: false,
    remove: null as null | ((event: { data: { action: unknown } }) => void),
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({ usePreventRemove: (enabled, callback) => {
        boundary.preventRemove = enabled;
        boundary.remove = callback;
    } });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        alert: (_title, _message, buttons) => { boundary.buttons = buttons ?? []; },
    } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

beforeEach(() => { boundary.buttons = []; boundary.preventRemove = false; boundary.remove = null; });
afterEach(standardCleanup);

describe('useUnsavedDraftNavigationGuard', () => {
    it('keeps Back distinct from an explicit discard destination through the same decision', async () => {
        const { useUnsavedDraftNavigationGuard } = await import('./useUnsavedDraftNavigationGuard');
        const navigation = { isFocused: () => true, addListener: () => () => {}, dispatch: vi.fn() };
        const back = vi.fn();
        const leave = vi.fn();
        const hook = await renderHook(() => useUnsavedDraftNavigationGuard({
            navigation, isDirty: true, onBack: back, onLeave: leave, tag: 'distinct-back',
        }));
        await act(async () => hook.getCurrent().requestBack());
        await act(async () => boundary.buttons.find(button => button.style === 'cancel')?.onPress?.());
        expect(back).not.toHaveBeenCalled();
        await act(async () => boundary.remove?.({ data: { action: { type: 'GO_BACK' } } }));
        await act(async () => boundary.buttons.find(button => button.style === 'destructive')?.onPress?.());
        expect(back).toHaveBeenCalledOnce();
        expect(leave).not.toHaveBeenCalled();
        expect(navigation.dispatch).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().requestLeave());
        await act(async () => boundary.buttons.find(button => button.style === 'destructive')?.onPress?.());
        expect(leave).toHaveBeenCalledOnce();
    });
    it('uses the authoring destination after discarding a native Back, without redispatching unrelated history', async () => {
        const { useUnsavedDraftNavigationGuard } = await import('./useUnsavedDraftNavigationGuard');
        const navigation = { isFocused: () => true, addListener: () => () => {}, dispatch: vi.fn() };
        const leave = vi.fn();
        await renderHook(() => useUnsavedDraftNavigationGuard({ navigation, isDirty: true, onLeave: leave, tag: 'draft-back' }));
        await act(async () => boundary.remove?.({ data: { action: { type: 'GO_BACK' } } }));
        await act(async () => boundary.buttons.find(button => button.style === 'destructive')?.onPress?.());
        expect(leave).toHaveBeenCalledOnce();
        expect(navigation.dispatch).not.toHaveBeenCalled();
    });
    it('offers only discard and keep-editing when the editor has no save continuation', async () => {
        const { useUnsavedDraftNavigationGuard } = await import('./useUnsavedDraftNavigationGuard');
        const { runGuardedNavigation } = await import('./runGuardedNavigation');
        const navigation = { isFocused: () => true, addListener: () => () => {}, dispatch: vi.fn() };
        const discard = vi.fn();
        const leave = vi.fn();
        await renderHook(() => useUnsavedDraftNavigationGuard({
            navigation, isDirty: true, onDiscard: discard, tag: 'draft-test',
        }));
        let result: true | Promise<boolean> = true;
        await act(async () => { result = runGuardedNavigation(leave); });
        await vi.waitFor(() => expect(boundary.buttons).toHaveLength(2));
        await act(async () => {
            boundary.buttons.find((button) => button.style === 'cancel')?.onPress?.();
            expect(await result).toBe(false);
        });
        expect(leave).not.toHaveBeenCalled();
        expect(discard).not.toHaveBeenCalled();

        await act(async () => { result = runGuardedNavigation(leave); });
        await act(async () => {
            boundary.buttons.find((button) => button.style === 'destructive')?.onPress?.();
            expect(await result).toBe(true);
        });
        expect(discard).toHaveBeenCalledOnce();
        expect(leave).toHaveBeenCalledOnce();
    });

    it('redispatches native back only after discard and releases successful-save navigation', async () => {
        const { useUnsavedDraftNavigationGuard } = await import('./useUnsavedDraftNavigationGuard');
        const navigation = { isFocused: () => true, addListener: () => () => {}, dispatch: vi.fn() };
        const hook = await renderHook(({ dirty }) => useUnsavedDraftNavigationGuard({
            navigation, isDirty: dirty, tag: 'native-draft-test',
        }), { initialProps: { dirty: true } });
        const action = { type: 'GO_BACK' };
        await act(async () => boundary.remove?.({ data: { action } }));
        await act(async () => boundary.buttons.find((button) => button.style === 'destructive')?.onPress?.());
        await vi.waitFor(() => expect(navigation.dispatch).toHaveBeenCalledWith(action));

        act(() => hook.getCurrent().allowSavedNavigation());
        await hook.rerender({ dirty: true });
        expect(boundary.preventRemove).toBe(false);
    });
});
