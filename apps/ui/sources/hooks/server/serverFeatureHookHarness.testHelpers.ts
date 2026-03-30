import React from 'react';

import {
    flushHookEffects as flushTestkitHookEffects,
    type FlushHookEffectsOptions,
    renderHook,
} from '@/dev/testkit';

export async function flushHookEffects(options: number | Partial<FlushHookEffectsOptions> = {}): Promise<void> {
    if (typeof options === 'number') {
        await flushTestkitHookEffects({
            cycles: 6,
            turns: options,
        });
        return;
    }

    await flushTestkitHookEffects({
        cycles: 6,
        turns: 4,
        ...options,
    });
}

export async function renderHookAndCollectValues<T>(useValue: () => T): Promise<T[]> {
    const seen: T[] = [];

    const harness = await renderHook(() => {
        const value = useValue();
        React.useEffect(() => {
            seen.push(value);
        }, [value]);
        return value;
    });
    await flushHookEffects();
    await harness.unmount();
    await flushTestkitHookEffects({ cycles: 1, turns: 1 });

    return seen;
}
