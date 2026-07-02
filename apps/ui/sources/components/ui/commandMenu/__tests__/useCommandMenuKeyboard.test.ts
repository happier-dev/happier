import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

import { useCommandMenuKeyboard } from '../useCommandMenuKeyboard';

function makeCallbacks() {
    return {
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
    };
}

function key(k: string, shiftKey = false): { key: string; shiftKey: boolean } {
    return { key: k, shiftKey };
}

describe('useCommandMenuKeyboard', () => {
    describe('when open is true', () => {
        it('ArrowDown calls onMoveDown and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('ArrowDown'))).toBe(true);
            expect(cbs.onMoveDown).toHaveBeenCalledOnce();
        });

        it('ArrowUp calls onMoveUp and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('ArrowUp'))).toBe(true);
            expect(cbs.onMoveUp).toHaveBeenCalledOnce();
        });

        it('Enter calls onSelect and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Enter'))).toBe(true);
            expect(cbs.onSelect).toHaveBeenCalledOnce();
        });

        it('Tab (no shift) calls onSelect and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Tab', false))).toBe(true);
            expect(cbs.onSelect).toHaveBeenCalledOnce();
        });

        it('Tab (with shift) returns false and does NOT call onSelect', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Tab', true))).toBe(false);
            expect(cbs.onSelect).not.toHaveBeenCalled();
        });

        it('Escape calls onClose and returns true', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Escape'))).toBe(true);
            expect(cbs.onClose).toHaveBeenCalledOnce();
        });

        it('Home returns false (parity; no new shortcuts)', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('Home'))).toBe(false);
        });

        it('End returns false (parity; no new shortcuts)', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('End'))).toBe(false);
        });

        it('any other key returns false', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: true, ...cbs }));
            expect(getCurrent().handleKey(key('a'))).toBe(false);
            expect(getCurrent().handleKey(key('Space'))).toBe(false);
            expect(getCurrent().handleKey(key('Backspace'))).toBe(false);
        });
    });

    describe('when open is false', () => {
        it('all keys return false and no callbacks are called', async () => {
            const cbs = makeCallbacks();
            const { getCurrent } = await renderHook(() => useCommandMenuKeyboard({ open: false, ...cbs }));
            expect(getCurrent().handleKey(key('ArrowDown'))).toBe(false);
            expect(getCurrent().handleKey(key('ArrowUp'))).toBe(false);
            expect(getCurrent().handleKey(key('Enter'))).toBe(false);
            expect(getCurrent().handleKey(key('Tab'))).toBe(false);
            expect(getCurrent().handleKey(key('Escape'))).toBe(false);
            expect(cbs.onMoveDown).not.toHaveBeenCalled();
            expect(cbs.onMoveUp).not.toHaveBeenCalled();
            expect(cbs.onSelect).not.toHaveBeenCalled();
            expect(cbs.onClose).not.toHaveBeenCalled();
        });
    });
});
