import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionRpcAvailabilityState } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    standardCleanup();
});

function buildSession(overrides?: Partial<Session>): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: { path: '/repo', host: 'localhost', machineId: 'machine-1' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('useSessionRpcAvailabilityState', () => {
    it('does not rerender when unrelated session fields change', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: { 'session-1': buildSession() },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionRpcAvailabilityState('session-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const initial = hook.getCurrent();
            expect(initial).toEqual({
                sessionExists: true,
                sessionRpcAvailable: true,
            });

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        'session-1': {
                            ...state.sessions['session-1'],
                            thinking: true,
                            thinkingAt: 2,
                        } as Session,
                    },
                }));
            });

            expect(hook.getCurrent()).toBe(initial);
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
