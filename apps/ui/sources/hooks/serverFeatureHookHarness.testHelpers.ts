import React from 'react';
import renderer, { act } from 'react-test-renderer';

export async function flushHookEffects(turns = 2) {
    for (let index = 0; index < turns; index += 1) {
        await Promise.resolve();
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
