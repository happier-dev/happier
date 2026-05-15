import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionWorkspacePath } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://example.com', generation: 1 }),
}));

afterEach(() => {
    standardCleanup();
});

function buildSession(overrides?: Partial<Session>): Session {
    return {
        id: 'session-1',
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: {
            host: 'localhost',
            machineId: 'machine-1',
            path: '/Users/alice/repo',
            homeDir: '/Users/alice',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('useSessionWorkspacePath', () => {
    it('returns a stable path primitive during unrelated session updates', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: { 'session-1': buildSession() },
                machines: {
                    'machine-1': {
                        id: 'machine-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: {
                            host: 'localhost',
                            platform: 'darwin',
                            happyCliVersion: '1',
                            happyHomeDir: '.happy',
                            homeDir: '/Users/alice',
                        },
                        metadataVersion: 1,
                        daemonState: null,
                        daemonStateVersion: 0,
                    },
                },
                sessionListRenderables: {},
                sessionListIndexByServerId: {},
                getProjectForSession: () => null,
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionWorkspacePath('session-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe('/Users/alice/repo');

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

            expect(hook.getCurrent()).toBe('/Users/alice/repo');
            expect(renderCount).toBe(1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
