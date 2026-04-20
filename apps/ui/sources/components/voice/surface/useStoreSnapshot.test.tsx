import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useStoreSnapshot } from './useStoreSnapshot';

describe('useStoreSnapshot', () => {
    it('re-reads the external store after subscribing so layout-effect hydration updates are not missed', async () => {
        let currentState = { value: 0 };
        const listeners = new Set<(state: { value: number }, prevState: { value: number }) => void>();

        const store = {
            getState: () => currentState,
            subscribe: (listener: (state: { value: number }, prevState: { value: number }) => void) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        };

        function Wrapper(props: React.PropsWithChildren) {
            React.useLayoutEffect(() => {
                const previousState = currentState;
                currentState = { value: 1 };
                for (const listener of listeners) {
                    listener(currentState, previousState);
                }
            }, []);
            return React.createElement(React.Fragment, null, props.children);
        }

        const hook = await renderHook(() => useStoreSnapshot(store), {
            wrapper: Wrapper,
        });

        expect(hook.getCurrent()).toEqual({ value: 1 });

        await hook.unmount();
    });
});
