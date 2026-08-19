import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applySessionListRenderablePatch,
    areSessionListRenderablesEqual,
    buildSessionListRenderableFromSession,
    derivePendingRequestFlagsFromAgentState,
    didSessionListRenderableAttentionPromotionFieldsChange,
    didSessionListRenderablePlacementRelevantTimingChange,
    didSessionListRenderableReachabilityPeerFieldsChange,
    didSessionListRenderableStructuralFieldsChange,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    resolveSessionListRenderableAttentionPromotionPlacement,
} from './sessionListRenderable';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { resolveSessionReadStateAction } from '../readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';
// The entry id is asked of the protocol owner, not spelled here. This projection joins the
// published headline by id, so a hand-written literal is a copy of the wire format that keeps
// passing after the real one moves.
import { buildAgentActivityEntryId } from '@happier-dev/protocol';
import { EMPTY_AGENT_ACTIVITY_COUNTS } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';

const storageState = vi.hoisted(() => ({
    sessionMessages: {} as Record<string, unknown>,
}));
const readStorageState = () => storageState as any;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => storageState,
            getInitialState: () => storageState,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    } as any);
});

beforeEach(() => {
    storageState.sessionMessages = {};
});

beforeEach(async () => {
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readStorageState);
});

function buildRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    const { id, ...rest } = overrides;

    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...rest,
    };
}

describe('derivePendingRequestFlagsFromAgentState', () => {
    it('treats legacy AskUserQuestion requests without kind as user actions', () => {
        const flags = derivePendingRequestFlagsFromAgentState({
            requests: {
                req1: {
                    tool: 'AskUserQuestion',
                    arguments: {},
                    createdAt: 1,
                },
            },
            completedRequests: {},
        } as any);

        expect(flags).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
    });
});

describe('preserveSessionListRenderableStaleFields', () => {
    it('reuses the previous metadata object when the rebuilt one is field-identical', () => {
        // Metadata is re-derived on every projection pass. When nothing in it changed, handing back
        // a fresh-but-equal object silently defeats identity all the way up: the session object is
        // rebuilt around it, so the list row is rebuilt, so the list array is rebuilt, so the whole
        // list re-renders. Measured on an idle list: ~4000 field-identical metadata rebuilds per 12s,
        // 99.8% of which changed nothing.
        const metadataFields = {
            path: '/repo',
            homeDir: '/home/user',
            host: 'host-a',
            machineId: 'machine-a',
            flavor: 'codex',
        };
        const previous = buildRenderable({
            id: 's_identity',
            metadata: { ...metadataFields },
            metadataVersion: 7,
        });
        const rebuiltButEqual = buildRenderable({
            id: 's_identity',
            metadata: { ...metadataFields },
            metadataVersion: 7,
        });
        expect(rebuiltButEqual.metadata).not.toBe(previous.metadata);

        const result = preserveSessionListRenderableStaleFields(previous, rebuiltButEqual);

        // Identity, not equality, is the contract — and the whole renderable is reused, not just
        // its metadata, because that is what the row/array reuse checks upstream compare.
        expect(result).toBe(previous);
        expect(result.metadata).toBe(previous.metadata);
    });

    it('takes the new metadata object when a field actually changed', () => {
        const previous = buildRenderable({
            id: 's_changed',
            metadata: { path: '/repo', flavor: 'codex' },
            metadataVersion: 7,
        });
        const changed = buildRenderable({
            id: 's_changed',
            metadata: { path: '/repo', flavor: 'claude' },
            metadataVersion: 8,
        });

        const result = preserveSessionListRenderableStaleFields(previous, changed);

        expect(result.metadata).toBe(changed.metadata);
        expect(result.metadata?.flavor).toBe('claude');
    });

    it('keeps metadata-unavailable settled state across placeholder replacements', () => {
        const previous = buildRenderable({
            id: 's_unavailable',
            metadata: null,
            metadataVersion: 2,
            metadataUnavailable: true,
        } as Partial<SessionListRenderableSession> & { id: string; metadataUnavailable: true });
        const next = preserveSessionListRenderableStaleFields(
            previous,
            buildRenderable({
                id: 's_unavailable',
                metadata: null,
                metadataVersion: 2,
            }),
        );

        expect((next as { metadataUnavailable?: boolean }).metadataUnavailable).toBe(true);
    });

    it('preserves stale metadata instead of metadata-unavailable state when safe metadata exists', () => {
        const previousMetadata = {
            path: '/repo',
            homeDir: '/home/user',
            host: 'host-a',
            machineId: 'machine-a',
            flavor: 'codex',
        };
        const previous = buildRenderable({
            id: 's_stale',
            metadata: previousMetadata,
            metadataVersion: 4,
            metadataUnavailable: true,
        } as Partial<SessionListRenderableSession> & { id: string; metadataUnavailable: true });
        const next = preserveSessionListRenderableStaleFields(
            previous,
            buildRenderable({
                id: 's_stale',
                metadata: null,
                metadataVersion: 5,
            }),
        );

        expect(next.metadata).toBe(previousMetadata);
        expect(next.metadataVersion).toBe(4);
        expect((next as { metadataUnavailable?: boolean }).metadataUnavailable).not.toBe(true);
    });
});

describe('buildSessionListRenderableFromSession', () => {
    /**
     * The count has to be projected here or it cannot exist at all: a session-list row is handed
     * this narrow object and never the session's real metadata, so a count read at the row would be
     * permanently zero on every virtualized list. It is derived from the published headline through
     * the one activity counter, so the number a row shows is the number the session's own pane
     * shows.
     */
    describe('agent activity count projection (R-8)', () => {
        function buildWithHeadline(activeStatuses: readonly string[]) {
            return buildSessionListRenderableFromSession({
                id: 's_agent_activity',
                seq: 4,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                metadata: {
                    path: '/repo',
                    sessionAgentActivityHeadlineV1: {
                        v: 1,
                        backendId: 'claude',
                        updatedAt: 1_000,
                        activeEntries: activeStatuses.map((status, index) => ({
                            entryId: buildAgentActivityEntryId({
                                kind: 'workflow_agent',
                                runId: 'run_1',
                                agentId: `a${index}`,
                            }),
                            kind: 'workflow_agent',
                            title: `Agent ${index}`,
                            status,
                            updatedAt: 1_000,
                        })),
                    },
                },
            } as unknown as Session);
        }

        it('projects how many agents are still working', () => {
            expect(buildWithHeadline(['running', 'queued', 'succeeded']).metadata?.agentActivityCounts)
                .toMatchObject({ live: 2, liveSubagents: 2 });
        });

        it('counts an agent stopped on a person, which is still an open agent', () => {
            expect(buildWithHeadline(['waiting']).metadata?.agentActivityCounts)
                .toMatchObject({ live: 1, liveSubagents: 1 });
        });

        it('projects zero for a session that has published no headline', () => {
            const renderable = buildSessionListRenderableFromSession({
                id: 's_no_headline',
                seq: 4,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                archivedAt: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
                metadata: { path: '/repo' },
            } as unknown as Session);

            expect(renderable.metadata?.agentActivityCounts).toEqual(EMPTY_AGENT_ACTIVITY_COUNTS);
        });
    });

    it('treats terminal turn projection as authoritative over legacy thinking in renderable state', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_terminal_thinking',
            seq: 4,
            lastViewedSessionSeq: 4,
            createdAt: 1,
            updatedAt: 10_000,
            active: true,
            activeAt: 10_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 9_500,
            thinking: true,
            thinkingAt: 10_000,
            presence: 'online',
        } as Session);

        expect(renderable.thinking).toBe(false);
        expect(renderable.thinkingAt).toBe(9_500);
        expect(renderable.latestTurnStatus).toBe('completed');
    });

    it('projects runtime activity fields onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_runtime_activity',
            seq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            runtimeActivityActiveCount: 0,
            runtimeActivityState: 'unknown',
            runtimeActivityObservedAt: 100,
            runtimeActivityRevision: 8,
        } as Session);

        expect(renderable.runtimeActivityActiveCount).toBe(0);
        expect(renderable.runtimeActivityState).toBe('unknown');
        expect(renderable.runtimeActivityObservedAt).toBe(100);
        expect(renderable.runtimeActivityRevision).toBe(8);
    });

    it('projects ready unread state onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_unread',
            seq: 4,
            lastViewedSessionSeq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
            latestReadyEventSeq: 4,
            latestReadyEventAt: 2_000,
        } as Session);

        expect(renderable.hasUnreadMessages).toBe(true);
    });

    it('does not mark cache-only non-terminal rows unread from raw session seq when transcript activity is unavailable', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_unhydrated_usage_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasUnreadMessages).toBe(false);
    });

    it('does not keep rows unread for trailing non-displayable session activity after visible messages are read', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_read_usage_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, [{
            id: 'm-visible',
            kind: 'agent-text',
            seq: 945,
            localId: null,
            createdAt: 1,
            text: 'Visible final assistant message',
        }]);

        expect(renderable.hasUnreadMessages).toBe(false);
    });

    it('does not treat trailing provider maintenance events as unread or meaningful activity', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_provider_event_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, [
            {
                id: 'm-visible',
                kind: 'agent-text',
                seq: 945,
                localId: null,
                createdAt: 1_000,
                text: 'Visible assistant message',
            },
            {
                id: 'm-provider-state',
                kind: 'agent-event',
                seq: 946,
                createdAt: 5_000,
                event: {
                    type: 'provider-state-sharing-degraded',
                    serviceId: 'anthropic',
                    requestedStateMode: 'shared',
                    effectiveStateMode: 'isolated',
                    code: 'state_symlink_unavailable',
                },
            },
        ]);

        expect(renderable.hasUnreadMessages).toBe(false);
        expect(renderable.meaningfulActivityAt).toBe(1_000);
    });

    it('keeps rows unread when a displayable message is newer than the cursor', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_unread_visible',
            seq: 946,
            lastViewedSessionSeq: 944,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, [{
            id: 'm-visible',
            kind: 'agent-text',
            seq: 945,
            localId: null,
            createdAt: 1,
            text: 'Visible assistant message',
        }]);

        expect(renderable.hasUnreadMessages).toBe(true);
    });

    it('projects runtime attention fields onto renderable session rows', () => {
        const lastRuntimeIssue = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'auth_error',
            source: 'auth_error',
            occurredAt: 123,
            sanitizedPreview: 'Authentication failed',
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's_failed',
            seq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'failed',
            lastRuntimeIssue,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        expect(renderable.latestTurnStatus).toBe('failed');
        expect(renderable.lastRuntimeIssue).toBe(lastRuntimeIssue);
    });

    it('projects ready event fields onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_ready',
            seq: 4,
            lastViewedSessionSeq: 3,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestReadyEventSeq: 4,
            latestReadyEventAt: 1_234,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        expect(renderable.latestReadyEventSeq).toBe(4);
        expect(renderable.latestReadyEventAt).toBe(1_234);
    });

    it('treats runtime attention fields as renderable equality inputs', () => {
        const previous = buildRenderable({
            id: 's_runtime',
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: null,
        } as any);
        const next = buildRenderable({
            id: 's_runtime',
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 123,
            },
        } as any);

        expect(areSessionListRenderablesEqual(previous, next)).toBe(false);
    });

    it('treats ready event fields as renderable equality inputs', () => {
        const previous = buildRenderable({
            id: 's_ready_equality',
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
        const next = buildRenderable({
            id: 's_ready_equality',
            latestReadyEventSeq: 5,
            latestReadyEventAt: 2_000,
        });

        expect(areSessionListRenderablesEqual(previous, next)).toBe(false);
    });

    it('treats runtime activity fields as renderable equality inputs', () => {
        const previous = buildRenderable({
            id: 's_runtime_activity_equality',
            runtimeActivityActiveCount: 1,
            runtimeActivityState: 'active',
            runtimeActivityObservedAt: 100,
            runtimeActivityRevision: 4,
        });
        const next = buildRenderable({
            id: 's_runtime_activity_equality',
            runtimeActivityActiveCount: 1,
            runtimeActivityState: 'active',
            runtimeActivityObservedAt: 150,
            runtimeActivityRevision: 5,
        });

        expect(areSessionListRenderablesEqual(previous, next)).toBe(false);
    });

    it('ignores progress timestamps when attention placement is unchanged', () => {
        const previous = buildRenderable({
            id: 's_action',
            updatedAt: 100,
            seq: 10,
            meaningfulActivityAt: 100,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: Date.now() - 1_000,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: Date.now() - 1_000,
        });
        const next = buildRenderable({
            id: 's_action',
            updatedAt: 200,
            seq: 11,
            meaningfulActivityAt: 200,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: Date.now() - 1_000,
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: previous.pendingRequestObservedAt,
        });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, next)).toBe(false);
    });

    it('keeps read-state actions derived from the projected session cursor', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_read',
            seq: 4,
            lastViewedSessionSeq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } satisfies Session);

        expect(renderable.latestTurnStatus).toBe('completed');
        expect(resolveSessionReadStateAction(renderable)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('keeps read-state actions derived from projected legacy metadata', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_legacy_read',
            seq: 4,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: {
                path: '',
                host: '',
                readStateV1: { v: 1, sessionSeq: 4, pendingActivityAt: 0, updatedAt: 1 },
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } satisfies Session);

        expect(resolveSessionReadStateAction(renderable)).toEqual({
            kind: 'mark-unread',
            visible: true,
            targetState: 'unread',
        });
    });

    it('preserves terminal-control serviceability in the session-list renderable projection', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_terminal_unservable', seq: 1, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, archivedAt: null,
            metadata: {
                path: '', host: '',
                terminal: {
                    mode: 'tmux', tmux: { target: 'happy:win-1' },
                    controlServiceabilityV1: {
                        v: 1,
                        attachmentId: 'attachment-preserved',
                        state: 'recoverable_unservable',
                        observedAt: 123,
                        reason: 'session_rpc_unavailable',
                    },
                },
            },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            latestTurnStatus: 'completed', thinking: false, thinkingAt: 0, presence: 1,
        } satisfies Session);

        expect(renderable.metadata?.terminalControlServiceabilityV1).toEqual({
            v: 1,
            attachmentId: 'attachment-preserved',
            state: 'recoverable_unservable',
            observedAt: 123,
            reason: 'session_rpc_unavailable',
        });
    });

    it('prefers projected pending-request counts when they are present on the session', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(true);
    });

    it('still prefers projected pending-request counts when completedRequests history exists', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: {
                    old_req: {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 1,
                        completedAt: 2,
                        status: 'approved',
                    },
                },
            },
            agentStateVersion: 3,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('projects pending request observed timestamps onto renderable session rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_pending_observed_at',
            seq: 1,
            createdAt: 1,
            updatedAt: 100,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 0,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 25,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.pendingRequestObservedAt).toBe(25);
    });

    it('still prefers projected pending-request counts when the cached transcript only has old terminal history', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-old',
                        localId: null,
                        createdAt: 50,
                        children: [],
                        tool: {
                            id: 'old_req',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'old?' },
                            createdAt: 50,
                            completedAt: 51,
                            permission: {
                                id: 'old_req',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1_000,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 3,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('prefers projected pending-request counts even when cached transcript history has a terminal outcome', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-terminal',
                        localId: null,
                        createdAt: 150,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 150,
                            completedAt: 151,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 100,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 3,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(true);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('suppresses inactive permission requests but keeps inactive user-action requests visible', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 },
                    req2: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 2 },
                },
                completedRequests: null,
            },
            agentStateVersion: 0,
            pendingPermissionRequestCount: 2,
            pendingUserActionRequestCount: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(true);
    });

    it('does not keep stale pending flags when the transcript already marked the request canceled', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 100,
                            completedAt: 101,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'continue?' }, createdAt: 100 },
                },
                completedRequests: null,
            },
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('keeps a newer pending request visible when an older transcript entry with the same id was canceled', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'AskUserQuestion',
                            state: 'error',
                            input: { q: 'continue?' },
                            createdAt: 100,
                            completedAt: 101,
                            permission: {
                                id: 'req1',
                                status: 'canceled',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const renderable = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    req1: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { q: 'continue again?' }, createdAt: 200 },
                },
                completedRequests: null,
            },
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(true);
    });
});

describe('didSessionListRenderableAttentionPromotionFieldsChange', () => {
    it('detects ready, pending, failed, and working-field changes that affect attention promotion', () => {
        const now = 1_000_000;
        const previous = buildRenderable({ id: 's_attention' });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            latestReadyEventSeq: 4,
        }, now)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            active: true,
            presence: 'online',
            hasPendingUserActionRequests: true,
            pendingRequestObservedAt: now - 1_000,
        }, now)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            active: true,
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'auth_error',
                source: 'auth_error',
                occurredAt: 123,
            },
        }, now)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: now - 1_000,
        }, now)).toBe(true);
    });

    it('detects unread placement changes without rebuilding for unrelated unread-stable updates', () => {
        const previous = buildRenderable({ id: 's_unread_only', hasUnreadMessages: false });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            hasUnreadMessages: true,
        })).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange({
            ...previous,
            hasUnreadMessages: true,
        }, {
            ...previous,
            hasUnreadMessages: true,
            seq: previous.seq + 1,
        })).toBe(false);
    });

    it('detects terminal status changes even when stale runtime freshness projects both rows outside placement', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_retained_working_terminal',
            seq: 10,
            lastViewedSessionSeq: 10,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 600_000,
            activeAt: now - 600_000,
            thinking: false,
            thinkingAt: 0,
        });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now,
        }, now)).toBe(true);
    });

    it('still ignores progress-only churn that never changes placement at any time', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_progress_churn',
            seq: 5,
            updatedAt: now - 10_000,
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 600_000,
            thinking: false,
            thinkingAt: 0,
        });

        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, {
            ...previous,
            seq: 6,
            updatedAt: now - 1_000,
        }, now)).toBe(false);
    });
});

describe('didSessionListRenderablePlacementRelevantTimingChange', () => {
    it('flags working-signal refreshes whose placements only diverge after a future freshness boundary', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_working_refresh',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 60_000,
            thinking: false,
            thinkingAt: 0,
        });

        // Both rows are 'working' at nowMs, but the refreshed observation
        // extends the working window: without a row refresh the committed
        // view data would demote the session at the STALE expiry while its
        // row (subscribed to the fresh renderable) still shows the spinner.
        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, {
            ...previous,
            latestTurnStatusObservedAt: now,
            activeAt: now,
        }, now)).toBe(true);
    });

    it('flags retention-input changes on retainable working sessions even when projections match at every horizon', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_retention_inputs',
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now - 60_000,
            activeAt: now - 600_000,
            thinking: false,
            thinkingAt: 0,
        });

        // activeAt stays below latestTurnStatusObservedAt so it never counts
        // as a working signal, but it gates working RETENTION (fresh activeAt
        // with thinking=false blocks retention). The committed view data must
        // pick this change up for retained-working evaluation.
        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, {
            ...previous,
            activeAt: now - 90_000,
        }, now)).toBe(true);
    });

    it('does not flag progress-only churn with no placement-relevant timing effect', () => {
        const now = 1_000_000;
        const previous = buildRenderable({
            id: 's_timing_churn',
            seq: 5,
            updatedAt: now - 10_000,
        });

        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, {
            ...previous,
            seq: 6,
            updatedAt: now - 1_000,
        }, now)).toBe(false);
    });
});

describe('didSessionListRenderableReachabilityPeerFieldsChange', () => {
    it('ignores progress timestamps that do not change reachability peers', () => {
        const previous = buildRenderable({
            id: 's_reachability',
            seq: 1,
            updatedAt: 100,
            meaningfulActivityAt: 100,
            active: true,
            metadata: {
                machineId: 'machine-a',
                host: 'host-a',
                path: '/repo',
                homeDir: '/home/alice',
            } as any,
        });

        expect(didSessionListRenderableReachabilityPeerFieldsChange(previous, {
            ...previous,
            seq: 2,
            updatedAt: 200,
            meaningfulActivityAt: 200,
        })).toBe(false);
    });

    it('ignores metadata-version-only updates when reachability metadata stays stable', () => {
        const previous = buildRenderable({
            id: 's_reachability_metadata_version',
            metadataVersion: 1,
            active: true,
            metadata: {
                machineId: 'machine-a',
                host: 'host-a',
                path: '/repo',
                homeDir: '/home/alice',
                name: 'Initial title',
            } as any,
        });

        expect(didSessionListRenderableReachabilityPeerFieldsChange(previous, {
            ...previous,
            metadataVersion: 2,
            metadata: {
                ...previous.metadata,
                name: 'Updated title',
                summaryText: 'Updated non-reachability summary',
            } as any,
        })).toBe(false);
    });
});

describe('buildSessionListRenderableFromSession with transcript aggregate', () => {
    function buildTranscriptFixture() {
        const messages = [
            {
                id: 'u1',
                kind: 'user-text',
                localId: null,
                createdAt: 1_000,
                seq: 3,
                text: 'run it',
            },
            {
                id: 't1',
                kind: 'tool-call',
                localId: null,
                createdAt: 2_000,
                seq: 5,
                tool: {
                    id: 't1-tool',
                    name: 'bash',
                    state: 'running',
                    input: { command: 'ls' },
                    createdAt: 2_000,
                    startedAt: 2_000,
                    completedAt: null,
                    description: null,
                    permission: {
                        id: 't1-perm',
                        status: 'pending',
                    },
                },
                children: [],
            },
            {
                id: 'a1',
                kind: 'agent-text',
                localId: null,
                createdAt: 3_000,
                seq: 7,
                text: 'done',
            },
        ] as unknown as import('@/sync/domains/messages/messageTypes').Message[];

        const session = {
            id: 's_aggregate',
            seq: 7,
            lastViewedSessionSeq: 3,
            createdAt: 1,
            updatedAt: 3_000,
            active: true,
            activeAt: 3_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: {
                requests: {},
                completedRequests: null,
            },
            agentStateVersion: 2,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as unknown as Session;

        return { session, messages };
    }

    it('derives a byte-identical renderable from the aggregate without a messages walk', async () => {
        const { buildTranscriptRenderableAggregate } = await import('@/sync/domains/messages/transcriptRenderableAggregate');
        const { session, messages } = buildTranscriptFixture();

        const fromMessages = buildSessionListRenderableFromSession(session, messages);
        const aggregate = buildTranscriptRenderableAggregate({
            messages,
            completedRequests: null,
        });
        const fromAggregate = buildSessionListRenderableFromSession(session, undefined, aggregate);

        expect(fromAggregate).toEqual(fromMessages);
        expect(fromMessages.hasPendingPermissionRequests).toBe(true);
        expect(fromMessages.hasUnreadMessages).toBe(true);
        expect(fromMessages.meaningfulActivityAt).toBe(3_000);
        expect(fromMessages.pendingRequestObservedAt).toBe(2_000);
    });

    it('does not fall back to stored-transcript reads when an aggregate is provided', async () => {
        const { buildTranscriptRenderableAggregate } = await import('@/sync/domains/messages/transcriptRenderableAggregate');
        const { session, messages } = buildTranscriptFixture();

        // Poison the storage bridge for this session: a stored-messages
        // fallback would surface this bogus transcript.
        storageState.sessionMessages[session.id] = {
            messageIdsOldestFirst: [],
            messagesById: {},
            messagesVersion: 0,
        };

        const aggregate = buildTranscriptRenderableAggregate({
            messages,
            completedRequests: null,
        });
        const fromAggregate = buildSessionListRenderableFromSession(session, undefined, aggregate);

        expect(fromAggregate.hasPendingPermissionRequests).toBe(true);
        expect(fromAggregate.pendingRequestObservedAt).toBe(2_000);
    });
});

describe('unread attention membership is a boolean edge', () => {
    const NOW_MS = 1_000_000;

    function buildUnreadRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
        // Materialize through the canonical ingest merge owner so the row
        // carries whatever unread-entry fact production would have stamped.
        return preserveSessionListRenderableTransientState(undefined, buildRenderable({
            id: 's_unread_edge',
            seq: 10,
            lastViewedSessionSeq: 5,
            hasUnreadMessages: true,
            createdAt: NOW_MS - 600_000,
            updatedAt: NOW_MS - 300_000,
            meaningfulActivityAt: NOW_MS - 300_000,
            ...overrides,
        }));
    }

    it('KEYSTONE: advancing unread activity time changes nothing structurally and never rebuilds or re-sorts', () => {
        const previous = buildUnreadRenderable();
        const next = preserveSessionListRenderableTransientState(previous, {
            ...previous,
            seq: previous.seq + 1,
            updatedAt: NOW_MS - 1_000,
            meaningfulActivityAt: NOW_MS - 1_000,
        });

        // Still unread: membership did not move.
        expect(next.hasUnreadMessages).toBe(true);
        // No structural change.
        expect(didSessionListRenderableStructuralFieldsChange(previous, next)).toBe(false);
        // No index rebuild (this gate drives needsSessionListViewDataRebuild).
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, next, NOW_MS)).toBe(false);
        // No list notification (this gate drives the committed row refresh).
        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, next, NOW_MS)).toBe(false);
        // No re-sort: the attention ordering key is unchanged.
        expect(resolveSessionListRenderableAttentionPromotionPlacement(next, NOW_MS))
            .toEqual(resolveSessionListRenderableAttentionPromotionPlacement(previous, NOW_MS));
    });

    it('keeps the unread ordering key stable across a full-renderable patch that omits it', () => {
        const previous = buildUnreadRenderable();
        const incoming = buildRenderable({
            ...previous,
            unreadSince: null,
            seq: previous.seq + 1,
            updatedAt: NOW_MS - 1_000,
            meaningfulActivityAt: NOW_MS - 1_000,
        });
        const next = applySessionListRenderablePatch(previous, incoming);

        expect(next.unreadSince).toBe(previous.unreadSince);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(previous, next, NOW_MS)).toBe(false);
        expect(didSessionListRenderablePlacementRelevantTimingChange(previous, next, NOW_MS)).toBe(false);
    });

    it('enters and leaves attention on the read/unread membership edges', () => {
        const unread = buildUnreadRenderable();
        const read = preserveSessionListRenderableTransientState(unread, {
            ...unread,
            lastViewedSessionSeq: unread.seq,
            hasUnreadMessages: false,
        });

        expect(resolveSessionListRenderableAttentionPromotionPlacement(unread, NOW_MS).kind).toBe('unread');
        expect(resolveSessionListRenderableAttentionPromotionPlacement(read, NOW_MS).kind).toBe('none');
        expect(didSessionListRenderableAttentionPromotionFieldsChange(unread, read, NOW_MS)).toBe(true);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(read, unread, NOW_MS)).toBe(true);
        expect(read.unreadSince ?? null).toBeNull();
    });

    it('stamps a fresh unread entry time when a read session becomes unread again', () => {
        const unread = buildUnreadRenderable();
        const read = preserveSessionListRenderableTransientState(unread, {
            ...unread,
            lastViewedSessionSeq: unread.seq,
            hasUnreadMessages: false,
        });
        const unreadAgain = preserveSessionListRenderableTransientState(read, {
            ...read,
            seq: read.seq + 5,
            hasUnreadMessages: true,
            updatedAt: NOW_MS - 2_000,
            meaningfulActivityAt: NOW_MS - 2_000,
        });

        expect(unreadAgain.unreadSince).toBe(NOW_MS - 2_000);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(read, unreadAgain, NOW_MS)).toBe(true);
    });

    it('consumes a server-materialized unread entry time when the client has none', () => {
        const renderable = preserveSessionListRenderableTransientState(undefined, buildRenderable({
            id: 's_unread_server',
            seq: 10,
            lastViewedSessionSeq: 5,
            hasUnreadMessages: true,
            createdAt: NOW_MS - 600_000,
            updatedAt: NOW_MS - 10_000,
            meaningfulActivityAt: NOW_MS - 10_000,
            unreadSince: NOW_MS - 450_000,
        }));

        expect(renderable.unreadSince).toBe(NOW_MS - 450_000);
        expect(resolveSessionListRenderableAttentionPromotionPlacement(renderable, NOW_MS)).toEqual({
            kind: 'unread',
            timestamp: NOW_MS - 450_000,
        });
    });

    it('KEYSTONE: a warm-hydrated unread row adopts the server entry fact and holds it across activity', async () => {
        const { buildSessionListRenderableFromCacheEntry } = await import('@/sync/domains/state/warmCacheAdapters');
        const serverUnreadSince = NOW_MS - 450_000;

        // Cold boot: the row is painted from the warm cache before the network
        // answers, from an entry written before the entry fact existed.
        const hydrated = buildSessionListRenderableFromCacheEntry({
            sessionId: 's_warm_unread',
            seq: 12,
            metadataVersion: 2,
            agentStateVersion: 4,
            createdAt: NOW_MS - 600_000,
            updatedAt: NOW_MS - 10_000,
            meaningfulActivityAt: NOW_MS - 10_000,
            active: false,
            activeAt: NOW_MS - 10_000,
            archivedAt: null,
            lastViewedSessionSeq: 5,
            path: '/home/u/repo',
            hasUnreadMessages: true,
        });

        expect(hydrated.unreadSince ?? null).toBeNull();

        // The server row carries the materialized entry fact; it is authoritative
        // over anything the client would derive from the warm row's activity.
        const merged = preserveSessionListRenderableTransientState(hydrated, buildRenderable({
            ...hydrated,
            unreadSince: serverUnreadSince,
        }));

        expect(merged.unreadSince).toBe(serverUnreadSince);
        expect(resolveSessionListRenderableAttentionPromotionPlacement(merged, NOW_MS)).toEqual({
            kind: 'unread',
            timestamp: serverUnreadSince,
        });

        // Activity-only update while the row stays unread: the entry fact is
        // unchanged, so the attention lane must not re-sort.
        const afterActivity = preserveSessionListRenderableTransientState(merged, buildRenderable({
            ...merged,
            seq: merged.seq + 1,
            updatedAt: NOW_MS - 1_000,
            meaningfulActivityAt: NOW_MS - 1_000,
            unreadSince: serverUnreadSince,
        }));

        expect(afterActivity.unreadSince).toBe(serverUnreadSince);
        expect(didSessionListRenderableAttentionPromotionFieldsChange(merged, afterActivity, NOW_MS)).toBe(false);
    });

    it('carries only the server entry fact out of the renderable builder and leaves the stamp to the merge owner', () => {
        const legacyServerSession = {
            id: 's_legacy_unread',
            seq: 12,
            lastViewedSessionSeq: 5,
            createdAt: NOW_MS - 600_000,
            updatedAt: NOW_MS - 10_000,
            meaningfulActivityAt: NOW_MS - 10_000,
            active: false,
            activeAt: NOW_MS - 10_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: NOW_MS - 10_000,
            latestTurnStatus: 'cancelled',
        } as unknown as Session;

        // An older server reports no entry fact: the builder must not invent one,
        // otherwise the merge owner cannot tell a server value from a client guess.
        const legacy = buildSessionListRenderableFromSession(legacyServerSession);
        expect(legacy.hasUnreadMessages).toBe(true);
        expect(legacy.unreadSince ?? null).toBeNull();
        expect(preserveSessionListRenderableTransientState(undefined, legacy).unreadSince)
            .toBe(legacy.meaningfulActivityAt);

        const fromServer = buildSessionListRenderableFromSession({
            ...legacyServerSession,
            unreadSince: NOW_MS - 450_000,
        } as unknown as Session);
        expect(fromServer.unreadSince).toBe(NOW_MS - 450_000);
    });
});
