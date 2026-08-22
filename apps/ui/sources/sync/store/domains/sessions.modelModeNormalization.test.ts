import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionsDomain } from './sessions';
import type { Session } from '../../domains/state/storageTypes';
import {
    clearPersistence,
    loadSessionModelModeUpdatedAts,
    loadSessionModelModes,
    saveSessionModelModeUpdatedAts,
    saveSessionModelModes,
} from '../../domains/state/persistence';

function createHarness(initialState: Record<string, unknown> = {}) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListRowStateByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
        ...initialState,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain };
}

function createRevisionedSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'revisioned-session',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

describe('sessions domain: modelMode normalization', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('prefers metadata.modelOverrideV1 when it is newer than local state', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    flavor: 'gemini',
                    modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'gemini-2.5-pro' },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-pro');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(1000);
    });

    it('reads layout-v1 model intent from the owner view without merging private fields into shared metadata', () => {
        const { get, domain } = createHarness();

        domain.applySessions([{
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            },
            ownerMetadataView: {
                flavor: 'gemini',
                path: '/owner/repo',
                machineId: 'owner-machine',
                modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'gemini-2.5-pro' },
            },
        } as any]);

        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-pro');
        expect(get().sessions.s1.metadata).toEqual({
            v: 1,
            summary: { text: 'Shared title', updatedAt: 1 },
        });

        domain.applySessions([{
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 2,
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Updated shared title', updatedAt: 2 },
            },
            ownerMetadataView: {
                flavor: 'gemini',
                modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'gemini-2.5-pro' },
            },
        } as any]);

        expect(get().sessions.s1.metadata).toEqual({
            v: 1,
            summary: { text: 'Updated shared title', updatedAt: 2 },
        });
        expect(get().sessions.s1.metadata).not.toHaveProperty('path');
        expect(get().sessions.s1.metadata).not.toHaveProperty('machineId');
        expect(get().sessions.s1.ownerMetadataView).not.toHaveProperty('path');
        expect(get().sessions.s1.ownerMetadataView).not.toHaveProperty('machineId');
    });

    it('projects a newer canonical provider-bound selection and canonical clear intent', () => {
        const { get, domain } = createHarness();

        domain.applySessions([{
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadata: {
                flavor: 'claude',
                modelSelectionIntentV1: {
                    v: 1,
                    updatedAt: 1000,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: 'pc_01J00000000000000000000000',
                        modelId: 'provider/claude-sonnet',
                    },
                },
            },
        } as any]);

        expect(get().sessions.s1.modelMode).toBe('provider/claude-sonnet');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(1000);

        domain.applySessions([{
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadata: {
                flavor: 'claude',
                modelSelectionIntentV1: { v: 1, updatedAt: 1001, selection: null },
            },
        } as any]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(1001);
    });

    it('drops a local model selection the Agent transition explicitly cleared', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const { get, domain } = createHarness();

        domain.applySessions([{
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadata: { flavor: 'gemini' },
        } as any]);
        domain.updateSessionModelMode('s1', 'gemini-2.5-flash' as any);
        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-flash');

        // The cutover to an Agent that accepts freeform model ids: the local
        // selection is not "invalid" for Claude, so the selectability clamp
        // cannot catch it. Only the transition's own cleared intent can.
        domain.applySessions([{
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadata: {
                flavor: 'claude',
                modelSelectionIntentV1: { v: 1, updatedAt: 2000, selection: null },
            },
        } as any]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(2000);
    });

    it('stamps modelModeUpdatedAt when updating the session model mode locally', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        domain.updateSessionModelMode('s1', 'gemini-2.5-pro' as any);

        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-pro');
        expect(typeof get().sessions.s1.modelModeUpdatedAt).toBe('number');
    });

    it('marks a model-stamped context snapshot stale immediately when the active model changes', () => {
        const snapshot = {
            v: 1,
            modelId: 'model-a',
            usedTokens: 42_000,
            windowTokens: 400_000,
            totalProcessedTokens: 120_000,
            baselineTokens: 12_000,
            isAutoCompactEnabled: null,
            categories: null,
            observedAtMs: 1_000,
            source: 'provider_turn',
        };
        const latestUsage = {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 42_000,
            contextWindowTokens: 400_000,
            contextSnapshot: snapshot,
            contextSnapshotStale: false,
            timestamp: 1_000,
        };
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: null,
                    modelMode: 'model-a',
                    latestUsage,
                },
            },
            sessionMessages: {
                s1: { reducerState: { latestUsage } },
            },
        });

        domain.updateSessionModelMode('s1', 'model-b' as any);

        expect(get().sessionMessages.s1.reducerState.latestUsage).toMatchObject({
            contextSnapshot: snapshot,
            contextSnapshotStale: true,
        });
    });

    it('persists a loaded session model mode without dropping unloaded session model modes', () => {
        vi.spyOn(Date, 'now').mockReturnValue(5000);
        saveSessionModelModes({
            s_loaded: 'gemini-2.5-pro',
            s_unloaded: 'claude-3-5-sonnet-latest',
        });
        saveSessionModelModeUpdatedAts({
            s_loaded: 1000,
            s_unloaded: 2000,
        });
        const { domain } = createHarness();

        domain.applySessions([
            {
                id: 's_loaded',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        domain.updateSessionModelMode('s_loaded', 'gpt-5.5' as any);

        expect(loadSessionModelModes()).toEqual({
            s_loaded: 'gpt-5.5',
            s_unloaded: 'claude-3-5-sonnet-latest',
        });
        expect(loadSessionModelModeUpdatedAts()).toEqual({
            s_loaded: 5000,
            s_unloaded: 2000,
        });
    });

    it('clamps invalid local model selections for agents without freeform model selection', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'codex' },
            } as any,
        ]);

        domain.updateSessionModelMode('s1', 'not-a-real-model' as any);

        expect(get().sessions.s1.modelMode).toBe('default');
    });

    it('clamps invalid persisted model modes to default for agents without freeform model selection', () => {
        saveSessionModelModes({ s1: 'not-a-real-model' });
        saveSessionModelModeUpdatedAts({ s1: 123 });

        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'codex' },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(123);
    });

    it('clamps invalid persisted model modes using canonical runtime metadata when flavor is absent', () => {
        saveSessionModelModes({ s1: 'not-a-real-model' });
        saveSessionModelModeUpdatedAts({ s1: 123 });

        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        provider: {},
                    },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(123);
    });

    it('preserves persisted freeform model ids for agents that allow them', () => {
        saveSessionModelModes({ s1: 'claude-3-5-sonnet-latest' });
        saveSessionModelModeUpdatedAts({ s1: 123 });

        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'claude' },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('claude-3-5-sonnet-latest');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(123);
    });

    it('ignores invalid metadata model overrides for agents without freeform model selection', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    flavor: 'codex',
                    modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'not-a-real-model' },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(1000);
    });

    it('does not churn clamped metadata model overrides across repeated applySessions calls', () => {
        const { get, domain } = createHarness();
        const payload = {
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadata: {
                flavor: 'codex',
                modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'not-a-real-model' },
            },
        } as any;

        domain.applySessions([payload]);
        const firstUpdatedAt = get().sessions.s1.modelModeUpdatedAt;
        domain.applySessions([payload]);
        const secondUpdatedAt = get().sessions.s1.modelModeUpdatedAt;

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(firstUpdatedAt).toBe(1000);
        expect(secondUpdatedAt).toBe(1000);
    });

    it('rejects a deferred stale metadata and Agent tuple while accepting newer independent session progress', () => {
        const { get, domain } = createHarness();
        const newer = createRevisionedSession({
            seq: 10,
            updatedAt: 10,
            activeAt: 10,
            metadataLayoutVersion: 1,
            metadata: {
                summary: { text: 'new shared', updatedAt: 10 },
            } as unknown as Session['metadata'],
            metadataVersion: 2,
            ownerMetadataView: { path: '/owner/new', host: 'owner-host' },
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 2,
        });
        const staleDeferred = createRevisionedSession({
            seq: 11,
            updatedAt: 11,
            activeAt: 11,
            metadataLayoutVersion: 1,
            metadata: {
                summary: { text: 'stale shared', updatedAt: 9 },
            } as unknown as Session['metadata'],
            metadataVersion: 1,
            ownerMetadataView: { path: '/owner/stale', host: 'owner-host' },
            agentState: {
                controlledByUser: false,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 1,
        });

        domain.applySessions([newer]);
        domain.applySessions([staleDeferred]);

        expect(get().sessions['revisioned-session']).toMatchObject({
            seq: 11,
            updatedAt: 11,
            metadataLayoutVersion: 1,
            metadataVersion: 2,
            metadata: { summary: { text: 'new shared', updatedAt: 10 } },
            ownerMetadataView: { path: '/owner/new' },
            agentStateVersion: 2,
            agentState: { controlledByUser: true },
        });
    });

    it('fences layout downgrade independently from Agent and later metadata revision progress', () => {
        const { get, domain } = createHarness();
        domain.applySessions([createRevisionedSession({
            seq: 10,
            metadataLayoutVersion: 1,
            metadata: {
                summary: { text: 'layout one', updatedAt: 10 },
            } as unknown as Session['metadata'],
            metadataVersion: 2,
            ownerMetadataView: { path: '/owner/layout-one', host: 'owner-host' },
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 2,
        })]);

        domain.applySessions([createRevisionedSession({
            seq: 11,
            metadataLayoutVersion: 0,
            metadata: { path: '/legacy/downgrade', host: 'legacy-host' },
            metadataVersion: 3,
            agentState: {
                controlledByUser: false,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 3,
        })]);

        expect(get().sessions['revisioned-session']).toMatchObject({
            seq: 11,
            metadataLayoutVersion: 1,
            metadataVersion: 2,
            metadata: { summary: { text: 'layout one', updatedAt: 10 } },
            ownerMetadataView: { path: '/owner/layout-one' },
            agentStateVersion: 3,
            agentState: { controlledByUser: false },
        });

        domain.applySessions([createRevisionedSession({
            seq: 12,
            metadataLayoutVersion: 1,
            metadata: {
                summary: { text: 'layout one current', updatedAt: 12 },
            } as unknown as Session['metadata'],
            metadataVersion: 4,
            ownerMetadataView: { path: '/owner/current', host: 'owner-host' },
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 2,
        })]);

        expect(get().sessions['revisioned-session']).toMatchObject({
            seq: 12,
            metadataLayoutVersion: 1,
            metadataVersion: 4,
            ownerMetadataView: { path: '/owner/current' },
            agentStateVersion: 3,
            agentState: { controlledByUser: false },
        });
    });

    it('treats a layout-v1 participant projection as an authoritative privacy contraction', () => {
        const { get, domain } = createHarness();
        domain.applySessions([createRevisionedSession({
            seq: 10,
            metadataLayoutVersion: 0,
            metadata: {
                path: '/private/legacy-worktree',
                host: 'private-legacy-host',
                machineId: 'private-legacy-machine',
            },
            metadataVersion: 9,
            ownerMetadataView: {
                path: '/private/owner-worktree',
                host: 'private-owner-host',
                machineId: 'private-owner-machine',
            },
            agentState: {
                controlledByUser: true,
                requests: {
                    privateRequest: {
                        tool: 'private-tool',
                        arguments: { secret: 'private-agent-state' },
                    },
                },
                completedRequests: {},
            },
            agentStateVersion: 8,
        })]);

        domain.applySessions([createRevisionedSession({
            seq: 11,
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 11 },
            } as unknown as Session['metadata'],
            metadataVersion: 1,
            ownerMetadataView: null,
            agentState: null,
            agentStateVersion: 7,
        })]);

        let contracted = get().sessions['revisioned-session'] as Session;
        expect(contracted).toMatchObject({
            seq: 11,
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadataVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 11 },
            },
            ownerMetadataView: null,
            agentState: null,
            agentStateVersion: 7,
        });
        expect(JSON.stringify(contracted)).not.toMatch(
            /private-legacy-worktree|private-owner-worktree|private-agent-state/,
        );

        domain.applySessions([createRevisionedSession({
            seq: 12,
            metadataLayoutVersion: 1,
            accessLevel: 'view',
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 11 },
            } as unknown as Session['metadata'],
            metadataVersion: 1,
            ownerMetadataView: null,
            agentState: {
                controlledByUser: true,
                requests: {
                    stalePrivateRequest: {
                        tool: 'stale-private-tool',
                        arguments: { secret: 'stale-private-agent-state' },
                    },
                },
                completedRequests: {},
            },
            agentStateVersion: 6,
        })]);

        contracted = get().sessions['revisioned-session'] as Session;
        expect(contracted.agentStateVersion).toBe(7);
        expect(contracted.agentState).toBeNull();
        expect(JSON.stringify(contracted)).not.toContain('stale-private-tool');
    });
});
