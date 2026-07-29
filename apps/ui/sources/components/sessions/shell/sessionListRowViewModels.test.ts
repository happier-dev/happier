import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { SESSION_OPTIMISTIC_PENDING_THINKING_MS } from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { t } from '@/text';
import { buildSessionListRowViewModels } from './sessionListRowViewModels';

function createRenderableSession(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 100,
        updatedAt: 200,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name: 'Stable session',
            path: '/repo/stable',
            homeDir: '/repo',
            host: 'test.local',
            machineId: 'machine-a',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

type SessionListSessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function rowKey(item: Pick<SessionListSessionIndexItem, 'serverId' | 'sessionId'>): string {
    const key = buildSessionListServerScopedRowKey(item.serverId, item.sessionId);
    if (!key) {
        throw new Error(`Expected a session-list row key for ${item.serverId}:${item.sessionId}`);
    }
    return key;
}

describe('buildSessionListRowViewModels', () => {
    it('keeps current-session selection derived only from selectedSessionId', () => {
        const firstItem = {
            type: 'session',
            sessionId: 'sess_selected_current',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const secondItem = {
            ...firstItem,
            sessionId: 'sess_not_current',
        } satisfies SessionListIndexItem;

        const rows = buildSessionListRowViewModels({
            listItems: [firstItem, secondItem],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([
                [rowKey(firstItem), createRenderableSession('sess_selected_current')],
                [rowKey(secondItem), createRenderableSession('sess_not_current')],
            ]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: 'sess_selected_current',
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows.map((row) => {
            expect(row).not.toBeNull();
            expect(row?.session).not.toBeNull();
            return [row?.session?.id, row?.selected];
        })).toEqual([
            ['sess_selected_current', true],
            ['sess_not_current', false],
        ]);
    });

    it('reuses row view models when a session renderable is structurally unchanged', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_stability',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const first = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), session]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });
        const equivalentSession = {
            ...session,
            metadata: session.metadata ? { ...session.metadata } : null,
        };

        const second = buildSessionListRowViewModels({
            listItems: [{ ...item }],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), equivalentSession]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(second[0]).toBe(first[0]);
    });

    it('derives animated working text for working rows by default', async () => {
        const { t } = await import('@/text');
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_working',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                active: true,
                thinking: true,
                thinkingAt: 900,
            }]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.sessionStatus?.state).toBe('thinking');
        expect(rows[0]?.sessionStatus?.statusText).not.toBe(t('status.working'));
    });

    it('derives static working text for working rows when requested', async () => {
        const { t } = await import('@/text');
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_static_working',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                active: true,
                thinking: true,
                thinkingAt: 900,
            }]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            workingTextMode: 'static',
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.sessionStatus?.state).toBe('thinking');
        expect(rows[0]?.sessionStatus?.statusText).toBe(t('status.working'));
    });

    it('uses the optimistic pending first-turn expiration for list-row freshness refreshes', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_pending_first_turn',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const nowMs = 1_000_000;
        const optimisticThinkingAt = nowMs - 1_000;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                active: true,
                optimisticThinkingAt,
                pendingCount: 1,
            }]]),
            relativeNowMs: nowMs,
            runtimeNowMs: nowMs,
            workingTextMode: 'static',
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.sessionStatus?.state).toBe('thinking');
        expect(rows[0]?.nextRuntimeFreshnessAtMs).toBe(optimisticThinkingAt + SESSION_OPTIMISTIC_PENDING_THINKING_MS);
    });

    it('keeps pushed external-Agent status separate from hosted control and shares its expiry wake', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_external_observation',
            serverId: 'server_a',
            storageKind: 'direct',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                presence: 900,
                metadata: {
                    ...session.metadata!,
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-a',
                        remoteSessionId: 'native-session-1',
                        source: {
                            kind: 'opencodeServer',
                            directory: '/repo/stable',
                        },
                    },
                    externalAgentObservationV1: {
                        v: 1,
                        qualifiedLinkIdentity: {
                            v: 1,
                            agent: {
                                pluginId: 'happier.opencode',
                                localId: 'opencode',
                            },
                            source: {
                                kind: 'opencode.server',
                                contractVersion: 1,
                            },
                        },
                        linkGeneration: 'link-generation-1',
                        status: 'working',
                        observedAtMs: 900,
                        expiresAtMs: 1_100,
                    },
                },
            }]]),
            relativeNowMs: 1_000,
            runtimeNowMs: 1_000,
            workingTextMode: 'static',
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect((rows[0] as any)?.externalSessionRuntime).toMatchObject({
            controlConnectivity: 'offline',
            detachedActivity: 'unknown',
            externalAgent: {
                state: 'working',
                labelKey: 'status.workingExternally',
            },
        });
        expect((rows[0] as any)?.externalSessionIdentity).toMatchObject({
            agentId: 'opencode',
            storageLabel: t('sessionsList.storageExternalFilter'),
            machineLabel: 'test.local',
        });
        expect(rows[0]?.nextRuntimeFreshnessAtMs).toBe(1_100);
        expect(rows[0]?.sessionStatus).toMatchObject({
            state: 'disconnected',
            isConnected: false,
        });

        const expiredRows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), rows[0]!.session!]]),
            relativeNowMs: 1_101,
            runtimeNowMs: 1_101,
            workingTextMode: 'static',
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect((expiredRows[0] as any)?.externalSessionRuntime).toMatchObject({
            controlConnectivity: 'offline',
            detachedActivity: 'unknown',
            externalAgent: {
                state: 'unknown',
                labelKey: 'status.externalStatusUnknown',
            },
        });
        expect(expiredRows[0]?.nextRuntimeFreshnessAtMs).toBeNull();
        expect(expiredRows[0]?.sessionStatus).toMatchObject({
            state: 'disconnected',
            isConnected: false,
        });
    });

    it('does not present malformed external-session-shaped metadata as a linked session', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_malformed_external',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const malformedSession = {
            ...session,
            metadata: {
                ...session.metadata!,
                externalSessionV1: { v: 1 },
            },
        } as unknown as SessionListRenderableSession;

        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), malformedSession]]),
            relativeNowMs: 1_000,
            runtimeNowMs: 1_000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.externalSessionIdentity).toBeNull();
        expect(rows[0]?.externalSessionRuntime).toBeNull();
    });
});
