import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useEndpointStatus } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    standardCleanup();
});

describe('useEndpointStatus', () => {
    it('does not rerender when only endpoint retry diagnostics change', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                endpointStatus: 'offline',
                endpointReason: 'initial',
                endpointAttempt: 1,
                endpointNextRetryAt: 100,
                endpointLastErrorMessage: 'first',
            }));
            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useEndpointStatus();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    endpointReason: 'retrying',
                    endpointAttempt: 2,
                    endpointNextRetryAt: 200,
                    endpointLastErrorMessage: 'second',
                }));
            });

            expect(hook.getCurrent()).toBe('offline');
            expect(renderCount).toBe(1);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    endpointStatus: 'online',
                }));
            });

            expect(hook.getCurrent()).toBe('online');
            expect(renderCount).toBe(2);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
