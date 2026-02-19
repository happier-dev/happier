import React from 'react';
import renderer, { act } from 'react-test-renderer';

export async function flushHookEffects(turns = 2) {
    // Some hooks schedule work via `useEffect` chains that require multiple turns (for example
    // fetching + parsing + state updates). Yield a few times to keep tests stable.
    for (let cycle = 0; cycle < 4; cycle += 1) {
        for (let index = 0; index < turns; index += 1) {
            await Promise.resolve();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

export async function renderHookAndCollectValues<T>(useValue: () => T): Promise<T[]> {
    const seen: T[] = [];

    function Test() {
        const value = useValue();
        React.useEffect(() => {
            seen.push(value);
        }, [value]);
        return null;
    }

    await act(async () => {
        renderer.create(React.createElement(Test));
        await flushHookEffects();
    });

    return seen;
}
