import { describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

import { createActivityAttentionStoreSourceSelector } from './createActivityAttentionStoreSourceSelector';

function expectNoObjectKeysOrValuesOnRecords(action: () => void, guardedRecords: readonly object[]): void {
    const originalObjectKeys = Object.keys.bind(Object);
    const originalObjectValues = Object.values.bind(Object);
    const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.keys');
        }
        return originalObjectKeys(value);
    }) as typeof Object.keys);
    const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(((value: object) => {
        if (guardedRecords.includes(value)) {
            throw new Error('selector materialized a guarded store record with Object.values');
        }
        return originalObjectValues(value);
    }) as typeof Object.values);

    try {
        expect(action).not.toThrow();
    } finally {
        keysSpy.mockRestore();
        valuesSpy.mockRestore();
    }
}

describe('createActivityAttentionStoreSourceSelector', () => {
    it('invalidates when the canonical external-session agent identity changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'external-agent-change',
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
        });
        const secondSession = createSessionFixture({
            ...firstSession,
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: { [firstSession.id]: firstSession },
        });
        const second = selector({
            ...baseState,
            sessions: { [secondSession.id]: secondSession },
        });

        expect(second).not.toBe(first);
        expect(second.sessionsById[secondSession.id]?.metadata?.externalSessionV1).toMatchObject({
            agentId: 'claude',
        });

        const thirdSession = createSessionFixture({
            ...secondSession,
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/codex' },
                },
            },
        });
        const third = selector({
            ...baseState,
            sessions: { [thirdSession.id]: thirdSession },
        });

        expect(third).not.toBe(second);
    });

    it('invalidates when plugin-owned external-session runtime evidence changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'external-runtime-evidence-change',
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: 'appServer' },
                    },
                    linkData: { checkpoint: 'before' },
                },
            },
        });
        const secondSession = createSessionFixture({
            ...firstSession,
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: 'acp' },
                    },
                    linkData: { checkpoint: 'after' },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: { [firstSession.id]: firstSession },
        });
        const second = selector({
            ...baseState,
            sessions: { [secondSession.id]: secondSession },
        });

        expect(second).not.toBe(first);
    });

    it('invalidates layout-v1 activity only when the owner metadata view changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const sharedMetadata = {
            v: 1,
            summary: { text: 'Shared title', updatedAt: 1 },
        } as const;
        const firstSession = createSessionFixture({
            id: 'layout-v1-owner-change',
            metadataLayoutVersion: 1,
            metadata: sharedMetadata as any,
            ownerMetadataView: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
            },
        });
        const secondSession = createSessionFixture({
            ...firstSession,
            ownerMetadataView: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/Users/tester/.claude' },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: { [firstSession.id]: firstSession },
        });
        const second = selector({
            ...baseState,
            sessions: { [secondSession.id]: secondSession },
        });

        expect(second).not.toBe(first);
    });

    it('tracks dynamic third-party external-session sources without a built-in catalog entry', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'dynamic-external-source',
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'external-only-agent',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'sharedLocalKind', scope: 'team:one' },
                },
            },
        });
        const secondSession = createSessionFixture({
            ...firstSession,
            metadata: {
                path: '/Users/tester/project',
                host: 'tester.local',
                externalSessionV1: {
                    v: 1,
                    agentId: 'external-only-agent',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'sharedLocalKind', scope: 'team:two' },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: { [firstSession.id]: firstSession },
        });
        const second = selector({
            ...baseState,
            sessions: { [secondSession.id]: secondSession },
        });

        expect(second).not.toBe(first);
        expect(second.sessionsById[secondSession.id]?.metadata?.externalSessionV1).toMatchObject({
            source: { kind: 'sharedLocalKind', scope: 'team:two' },
        });
    });

    it('invalidates when activity presentation metadata changes without a session sequence change', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const baseMetadata = {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
        } as const;
        const firstSession = createSessionFixture({
            id: 'presentation-change',
            metadata: {
                ...baseMetadata,
                summary: { text: 'Before', updatedAt: 1 },
            },
        });
        const secondSession = createSessionFixture({
            ...firstSession,
            metadata: {
                ...baseMetadata,
                summary: { text: 'After', updatedAt: 2 },
            },
        });

        const first = selector({
            ...baseState,
            sessions: {
                [firstSession.id]: firstSession,
            },
        });
        const second = selector({
            ...baseState,
            sessions: {
                [secondSession.id]: secondSession,
            },
        });

        expect(second).not.toBe(first);
        expect(second.sessionsById[secondSession.id]?.metadata?.summary?.text).toBe('After');
    });

    it('does not collapse distinct pending request fields that contain signature separators', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const baseSession = createSessionFixture({
            id: 'separator-session',
            pendingPermissionRequestCount: 1,
            agentState: {
                requests: {
                    'request:a': {
                        tool: 'b',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: {
                [baseSession.id]: baseSession,
            },
        });
        const nextSession = {
            ...baseSession,
            agentState: {
                requests: {
                    request: {
                        tool: 'a:b',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
        };
        const second = selector({
            ...baseState,
            sessions: {
                [nextSession.id]: nextSession,
            },
        });

        expect(second).not.toBe(first);
        expect(Object.keys(second.sessionsById[nextSession.id]?.agentState?.requests ?? {})).toEqual(['request']);
    });

    it('invalidates when same-id request coverage changes through arguments only', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'permission-retry',
            active: true,
            presence: 'online',
            agentState: {
                controlledByUser: null,
                requests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 950,
                    },
                },
                completedRequests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        completedAt: 960,
                        status: 'approved',
                    },
                },
            },
        });
        const secondSession = createSessionFixture({
            ...firstSession,
            agentState: {
                controlledByUser: null,
                requests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git diff' },
                        createdAt: 950,
                    },
                },
                completedRequests: firstSession.agentState?.completedRequests,
            },
        });

        const first = selector({
            ...baseState,
            sessions: {
                [firstSession.id]: firstSession,
            },
        });
        const second = selector({
            ...baseState,
            sessions: {
                [secondSession.id]: secondSession,
            },
        });

        expect(second).not.toBe(first);
        expect(second.sessionsById[secondSession.id]?.agentState?.requests?.approve?.arguments).toEqual({ command: 'git diff' });
    });

    it('invalidates when optimistic thinking starts without another session field changing', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'optimistic-thinking',
            optimisticThinkingAt: null,
        });
        const secondSession = {
            ...firstSession,
            optimisticThinkingAt: 1_000,
        };

        const first = selector({
            ...baseState,
            sessions: {
                [firstSession.id]: firstSession,
            },
        });
        const second = selector({
            ...baseState,
            sessions: {
                [secondSession.id]: secondSession,
            },
        });

        expect(second).not.toBe(first);
        expect(second.sessionsById[secondSession.id]?.optimisticThinkingAt).toBe(1_000);
    });

    it('invalidates when a retired Voice session receives a pending permission', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const retiredSession = createSessionFixture({
            id: 'retired-voice-permission',
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 0,
            metadata: {
                path: '/tmp/retired-voice-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const pendingSession = createSessionFixture({
            ...retiredSession,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: {
                requests: {
                    approve: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: 975,
                    },
                },
            },
        });

        const first = selector({
            ...baseState,
            sessions: {
                [retiredSession.id]: retiredSession,
            },
        });
        const second = selector({
            ...baseState,
            sessions: {
                [pendingSession.id]: pendingSession,
            },
        });

        expect(second).not.toBe(first);
        expect(second.sessionsById[pendingSession.id]?.pendingPermissionRequestCount).toBe(1);
    });

    it('does not invalidate attention when only the provider runtime activity projection changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'runtime-activity',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 900,
            runtimeActivityRevision: 1_000,
        });
        const secondSession = {
            ...firstSession,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_100,
            runtimeActivityRevision: 61_100,
        };

        const first = selector({
            ...baseState,
            sessions: {
                [firstSession.id]: firstSession,
            },
        });
        const second = selector({
            ...baseState,
            sessions: {
                [secondSession.id]: secondSession,
            },
        });

        expect(second).toBe(first);
        expect(second.sessionsById[secondSession.id]?.runtimeActivityActiveCount).toBe(0);
    });

    it('builds the source signature without Object.keys or Object.values over hot state records', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const session = createSessionFixture({
            id: 'hot-session',
            pendingPermissionRequestCount: 1,
        });
        const state = {
            ...baseState,
            sessions: {
                [session.id]: session,
            },
            sessionListRenderables: {},
        };
        let source: ReturnType<ReturnType<typeof createActivityAttentionStoreSourceSelector>> | undefined;

        expectNoObjectKeysOrValuesOnRecords(() => {
            source = selector(state);
        }, [state.sessions, state.sessionListRenderables]);

        expect(source?.sessionsById[session.id]).toBe(session);
    });
});
