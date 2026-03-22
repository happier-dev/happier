import React from 'react';

import {
    flushHookEffects as flushTestkitHookEffects,
    renderHook,
} from '@/dev/testkit';

export async function flushHookEffects(turns = 2) {
    await flushTestkitHookEffects({ turns });
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
