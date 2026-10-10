import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
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
    it('does no collection work on unrelated store ticks and refreshes a changed attention row', () => {
        let visits = 0;
        const watch = <T extends object>(value: T): T => new Proxy(value, {
            ownKeys(target) { visits += 1; return Reflect.ownKeys(target); },
            get(target, property, receiver) { visits += 1; return Reflect.get(target, property, receiver); },
        });
        const base = storage.getState();
        const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'waiting', serverId: 'home-a' }));
        const rows = watch({ waiting: row });
        const state = { ...base, sessions: watch({}), sessionListRowsByServerId: watch({ 'home-a': rows }),
            ordinarySessionListMembershipByServerId: watch({ 'home-a': ['waiting'] }),
            sessionMessages: watch({}), sessionListIndexByServerId: watch({}), concurrentSessionListCacheByServerId: watch({}) };
        const selector = createActivityAttentionStoreSourceSelector();
        const first = selector(state);
        visits = 0;
        expect(selector({ ...state, lastSyncAt: 123 })).toBe(first);
        expect(visits).toBe(0);
        expect(selector({ ...state, sessionMessages: {} })).toBe(first);
        expect(visits).toBe(0);

        const changed = { ...row, thinking: true, thinkingAt: 124 };
        const next = selector({ ...state, sessionListRowsByServerId: { 'home-a': { waiting: changed } } });
        expect(next).not.toBe(first);
        expect(next.sessionListRowsByServerId['home-a']?.waiting).toBe(changed);
    });

    it('computes each scoped address key once when sorting a large attention membership', () => {
        const base = storage.getState();
        const ids = Array.from({ length: 2_000 }, (_, index) => `session-${(index * 997) % 2_000}`);
        const stringify = vi.spyOn(JSON, 'stringify'); // Call-through instrumentation of key allocation, not substituted domain logic.
        try {
            createActivityAttentionStoreSourceSelector({}, { includeSessionMessages: false })({
                ...base, sessions: {}, ordinarySessionListMembershipByServerId: { 'home-a': ids }, sessionListRowsByServerId: {},
            });
            const keyAllocations = stringify.mock.calls.filter(([value]) => (
                Array.isArray(value) && value[0] === 'home-a' && typeof value[1] === 'string' && value[1].startsWith('session-')
            )).length;
            expect(keyAllocations).toBe(ids.length);
        } finally {
            stringify.mockRestore();
        }
    });

    it.runIf(process.env.HAPPIER_MEASURE_UI_HOT_LOOPS === '1')('measures 2,000 attention rows and unrelated ticks', () => {
        const base = storage.getState();
        const rows = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => {
            const id = `session-${(index * 997) % 2_000}`;
            return [id, buildSessionListRenderableFromSession(createSessionFixture({ id, serverId: 'home-a' }))];
        }));
        const state = { ...base, sessions: {}, sessionListRowsByServerId: { 'home-a': rows },
            ordinarySessionListMembershipByServerId: { 'home-a': Object.keys(rows) }, sessionMessages: {} };
        const selector = createActivityAttentionStoreSourceSelector();
        const start = performance.now();
        const first = selector(state);
        const coldMs = performance.now() - start;
        const tickStart = performance.now();
        for (let index = 0; index < 200; index++) expect(selector({ ...state, lastSyncAt: index })).toBe(first);
        console.log(JSON.stringify({ measurement: 'activity-attention', sessions: 2_000, unrelatedTicks: 200,
            coldMs, ticksMs: performance.now() - tickStart }));
    });

    it('does not project Session-list observations as an Activity-wide Home freshness fact', () => {
        const selector = createActivityAttentionStoreSourceSelector({ 'server-a': ['same-session'] });
        const base = storage.getState();
        const source = selector({
            ...base,
            concurrentSessionListCacheByServerId: {
                'server-b': {
                    serverName: 'Home B',
                    listObservation: { phase: 'ready', lastSuccessAt: 2_000 },
                },
            },
        });
        const observationOnlyChange = selector({
            ...base,
            concurrentSessionListCacheByServerId: {
                'server-b': {
                    serverName: 'Home B',
                    listObservation: { phase: 'offline', lastSuccessAt: 2_000 },
                },
            },
        });

        expect(source).not.toHaveProperty('sessionListHomeObservationByServerId');
        // The context line consumes Home currentness from the canonical cache,
        // not a second Activity-wide freshness projection.
        expect(observationOnlyChange).not.toBe(source);
        expect(observationOnlyChange.concurrentSessionListCacheByServerId['server-b']?.listObservation?.phase).toBe('offline');
    });

    it('projects workspace display settings and invalidates when their result changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const base = storage.getState();
        const workspaceRef = {
            id: 'workspace-a',
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
            lastOpenedAtMs: null,
        };
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const projectRows = (refs: readonly typeof workspaceRef[]) => ({ scope, status: 'ready' as const, coverage: 'complete' as const,
            workspaceRefs: refs, relationships: [], organizations: [], revisionsByPhysicalKey: {} });
        const first = selector({
            ...base,
            profileScope: scope,
            projectAccountRows: projectRows([workspaceRef]),
            settings: {
                ...base.settings,
                workspacePathDisplayModeV1: 'name',
            },
        });
        const same = selector({
            ...base,
            profileScope: scope,
            projectAccountRows: projectRows([{ ...workspaceRef }]),
            settings: {
                ...base.settings,
                workspacePathDisplayModeV1: 'name',
            },
        });
        const renamed = selector({
            ...base,
            profileScope: scope,
            projectAccountRows: projectRows([{ ...workspaceRef, label: 'Happier Core' }]),
            settings: {
                ...base.settings,
                workspacePathDisplayModeV1: 'name',
            },
        });
        const pathMode = selector({
            ...base,
            profileScope: scope,
            projectAccountRows: projectRows([{ ...workspaceRef, label: 'Happier Core' }]),
            settings: {
                ...base.settings,
                workspacePathDisplayModeV1: 'path',
            },
        });

        expect(first.workspaceRefsV1).toEqual([workspaceRef]);
        expect(first.workspacePathDisplayModeV1).toBe('name');
        expect(same).toBe(first);
        expect(renamed).not.toBe(first);
        expect(renamed.workspaceRefsV1?.[0]?.label).toBe('Happier Core');
        expect(pathMode).not.toBe(renamed);
        expect(pathMode.workspacePathDisplayModeV1).toBe('path');
    });

    it('does not swallow a changed safe audience when the Session sequence is unchanged', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const base = storage.getState();
        const session = createSessionFixture({ access: {
            role: 'recipient', level: 'view', capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
            audienceContext: { kind: 'team', teamId: 'team-a' },
        } });
        const first = selector({ ...base, sessions: { [session.id]: session } });
        const changed = { ...session, access: { ...session.access!, audienceContext: null } };
        const next = selector({ ...base, sessions: { [session.id]: changed } });
        expect(next).not.toBe(first);
        expect(next.sessionsById[session.id].access?.audienceContext).toBeNull();
    });

    it.each(['sessions', 'sessionListRowsByServerId'] as const)('refreshes answerability after grants change in %s without a sequence change', (sourceKind) => {
        const selector = createActivityAttentionStoreSourceSelector();
        const base = storage.getState();
        const session = createSessionFixture({ id: 'waiting', serverId: 'home-a' });
        const revoked = { ...session, access: { ...session.access!, capabilities: {
            ...session.access!.capabilities, submitAgentInput: false, approveRuntimePermissions: false,
        } } };
        const stateFor = (value: typeof session): typeof base => sourceKind === 'sessions'
            ? { ...base, sessions: { waiting: value } }
            : { ...base, sessions: {}, sessionListRowsByServerId: { 'home-a': {
                waiting: buildSessionListRenderableFromSession(value),
            } }, ordinarySessionListMembershipByServerId: { 'home-a': ['waiting'] } };

        const first = selector(stateFor(session));
        const next = selector(stateFor(revoked));
        expect(next).not.toBe(first);
        const updated = sourceKind === 'sessions' ? next.sessionsById.waiting : next.sessionListRowsByServerId['home-a']?.waiting;
        expect(updated?.access?.capabilities.submitAgentInput).toBe(false);
        expect(updated?.access?.capabilities.approveRuntimePermissions).toBe(false);
    });

    it('invalidates a viewer-only tracking change without a session sequence change', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const base = storage.getState();
        const session = Object.assign(createSessionFixture({ access: createSessionAccessFixture('edit') }), { viewer: {
            readState: { state: 'not_started' },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'none', source: 'none' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        } } as const);
        const first = selector({ ...base, sessions: { [session.id]: session } });
        const followed = { ...session, viewer: { ...session.viewer,
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            follow: { follows: true, notificationLevel: 'none' },
        } } as const;
        const second = selector({ ...base, sessions: { [session.id]: followed } });
        expect(second).not.toBe(first);
        expect(second.sessionsById[session.id]).toBe(followed);
    });

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

    it('invalidates attention when the provider runtime activity projection changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstSession = createSessionFixture({
            id: 'runtime-activity',
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: 900,
            runtimeActivityRevision: 1_000,
        });
        const secondSession = {
            ...firstSession,
            runtimeActivityState: 'active' as const,
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

        expect(second).not.toBe(first);
        expect(second.sessionsById[secondSession.id]).toMatchObject({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        });
    });

    it('invalidates a cached renderable when provider runtime activity changes', () => {
        const selector = createActivityAttentionStoreSourceSelector();
        const baseState = storage.getState();
        const firstRow = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'runtime-activity-renderable',
            serverId: 'server-a',
            runtimeActivityState: 'idle',
            runtimeActivityActiveCount: 0,
        }));
        const secondRow = {
            ...firstRow,
            runtimeActivityState: 'active' as const,
            runtimeActivityActiveCount: 1,
        };
        const first = selector({
            ...baseState,
            sessions: {},
            ordinarySessionListMembershipByServerId: { 'server-a': [firstRow.id] },
            sessionListRowsByServerId: { 'server-a': { [firstRow.id]: firstRow } },
        });
        const second = selector({
            ...baseState,
            sessions: {},
            ordinarySessionListMembershipByServerId: { 'server-a': [secondRow.id] },
            sessionListRowsByServerId: { 'server-a': { [secondRow.id]: secondRow } },
        });

        expect(second).not.toBe(first);
        expect(second.sessionListRowsByServerId['server-a']?.[secondRow.id]).toMatchObject({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
        });
    });

    it('invalidates for a changed personal-query row without scanning unrelated cached rows', () => {
        const selector = createActivityAttentionStoreSourceSelector({
            'server-a': ['collective-personal'],
        });
        const baseState = storage.getState();
        const firstRow = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'collective-personal',
            serverId: 'server-a',
            seq: 1,
            updatedAt: 1,
        }));
        const secondRow = { ...firstRow, seq: 2, updatedAt: 2 };
        const unrelated = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'unrelated-query-cache',
            serverId: 'server-a',
            seq: 10,
            updatedAt: 10,
        }));

        const first = selector({
            ...baseState,
            sessions: {},
            ordinarySessionListMembershipByServerId: { 'server-a': [] },
            sessionListRowsByServerId: {
                'server-a': {
                    [firstRow.id]: firstRow,
                    [unrelated.id]: unrelated,
                },
            },
        });
        const unrelatedOnly = selector({
            ...baseState,
            sessions: {},
            ordinarySessionListMembershipByServerId: { 'server-a': [] },
            sessionListRowsByServerId: {
                'server-a': {
                    [firstRow.id]: firstRow,
                    [unrelated.id]: { ...unrelated, seq: 11, updatedAt: 11 },
                },
            },
        });
        const changedPersonal = selector({
            ...baseState,
            sessions: {},
            ordinarySessionListMembershipByServerId: { 'server-a': [] },
            sessionListRowsByServerId: {
                'server-a': {
                    [secondRow.id]: secondRow,
                    [unrelated.id]: unrelated,
                },
            },
        });

        expect(unrelatedOnly).toBe(first);
        expect(changedPersonal).not.toBe(first);
        expect(changedPersonal.sessionListRowsByServerId['server-a']?.[secondRow.id]?.seq).toBe(2);
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
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
        };
        let source: ReturnType<ReturnType<typeof createActivityAttentionStoreSourceSelector>> | undefined;

        expectNoObjectKeysOrValuesOnRecords(() => {
            source = selector(state);
        }, [state.sessions, state.sessionListRowsByServerId]);

        expect(source?.sessionsById[session.id]).toBe(session);
    });
});
