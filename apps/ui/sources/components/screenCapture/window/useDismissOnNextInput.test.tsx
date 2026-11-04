import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { useDismissOnNextInput } from './useDismissOnNextInput';

afterEach(() => { vi.unstubAllGlobals(); });

it('listens only while a callout stands, and arms no timer', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('document', {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
    });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const onInput = vi.fn();
    const before = timer.mock.calls.length;
    const hook = await renderHook(({ active }: { active: boolean }) => useDismissOnNextInput(active, onInput), { initialProps: { active: false } });
    expect(listeners.size).toBe(0);
    await hook.rerender({ active: true });
    expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown']);
    listeners.get('keydown')?.();
    expect(onInput).toHaveBeenCalledTimes(1);
    await hook.rerender({ active: false });
    expect(listeners.size).toBe(0);
    expect(timer.mock.calls.filter(([, delay]) => typeof delay === 'number' && delay > 0).slice(before)).toEqual([]);
});
