import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildSessionListRenderableFromSession,
    derivePendingRequestFlagsFromAgentState,
    didSessionListRenderableReachabilityPeerFieldsChange,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
} from './sessionListRenderable';
import { resolveSessionReadStateAction } from '../readState/sessionReadState';
import { buildSessionListRenderableMetadataComparison } from './sessionListRenderableMetadataComparison';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from './sessionListRenderable';

const canonicalExternalSessionLink = {
    v: 1 as const,
    agentId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

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
    it('reuses a shared empty flags object when there are no requests', () => {
        const first = derivePendingRequestFlagsFromAgentState(null);
        const second = derivePendingRequestFlagsFromAgentState(undefined);
        const third = derivePendingRequestFlagsFromAgentState({
            requests: {},
            completedRequests: {},
        } as any);

        expect(first).toBe(second);
        expect(second).toBe(third);
        expect(first).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: false,
        });
    });

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

    it('preserves ready metadata and known unread across unread-unknown replacements', () => {
        const previous = buildRenderable({
            id: 's_ready',
            seq: 10,
            lastViewedSessionSeq: 8,
            latestTurnStatus: 'in_progress',
            latestReadyEventSeq: 9,
            latestReadyEventAt: 9_000,
            hasUnreadMessages: true,
        });
        const next = preserveSessionListRenderableStaleFields(
            previous,
            buildRenderable({
                id: 's_ready',
                seq: 10,
                lastViewedSessionSeq: 8,
                latestTurnStatus: 'in_progress',
                latestReadyEventSeq: null,
                latestReadyEventAt: null,
                hasUnreadMessages: false,
            }),
        );

        expect(next.latestReadyEventSeq).toBe(9);
        expect(next.latestReadyEventAt).toBe(9_000);
        expect(next.hasUnreadMessages).toBe(true);
    });
});

describe('buildSessionListRenderableFromSession', () => {
    it('projects layout-v1 owner-private list facts from the canonical owner view', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 'layout1-owner',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
                agentPresentation: { agentId: 'claude' },
            } as unknown as Session['metadata'],
            ownerMetadataView: {
                name: 'Owner name',
                path: '/owner/private/repo',
                homeDir: '/owner',
                host: 'owner.local',
                machineId: 'owner-machine',
                flavor: 'claude',
            } as Session['metadata'],
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        } as Session);

        expect(renderable.metadata).toMatchObject({
            name: 'Owner name',
            path: '/owner/private/repo',
            homeDir: '/owner',
            host: 'owner.local',
            machineId: 'owner-machine',
            flavor: 'claude',
        });
        expect(renderable.metadataUnavailable).not.toBe(true);
    });

    it('keeps layout-v1 participant renderables on strict shared metadata without owner facts', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 'layout1-participant',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
                agentPresentation: { agentId: 'claude' },
            } as unknown as Session['metadata'],
            ownerMetadataView: {
                name: 'Forbidden owner name',
                path: '/owner/private/repo',
                homeDir: '/owner',
                host: 'owner.local',
                machineId: 'owner-machine',
            } as Session['metadata'],
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        } as Session);

        expect(renderable.metadata).toEqual({
            name: undefined,
            summaryText: 'Shared title',
            path: '',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: 'claude',
            externalSessionV1: null,
            externalAgentObservationV1: null,
            readStateV1: null,
            hiddenSystemSession: false,
            terminalControlServiceabilityV1: null,
        });
        expect(renderable.metadataUnavailable).not.toBe(true);
    });

    it('marks a layout-v1 owner row unavailable when its owner view is absent', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 'layout1-owner-list-shell',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: { text: 'Shared title', updatedAt: 1 },
            } as unknown as Session['metadata'],
            ownerMetadataView: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        } as Session);

        expect(renderable.metadata).toBeNull();
        expect(renderable.metadataUnavailable).toBe(true);
    });

    it('does not use raw updatedAt as meaningful activity for inactive rows', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_inactive_churn',
            seq: 4,
            lastViewedSessionSeq: 4,
            createdAt: 1_000,
            updatedAt: 50_000,
            active: false,
            activeAt: 0,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        } satisfies Session);

        expect(renderable.meaningfulActivityAt).toBe(1_000);
    });

    it('projects the first user message as a transient title fallback when metadata has no display title', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_prompt_title_fallback',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            archivedAt: null,
            metadata: {
                path: '/Users/leeroy/Documents/Development/happier/dev',
                host: 'leeroy-mbp',
                homeDir: '/Users/leeroy',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } satisfies Session, undefined, [{
            id: 'm-user',
            kind: 'user-text',
            seq: 1,
            localId: null,
            createdAt: 1,
            text: 'QA detail/title/tool/turn-state audit 2026-07-01. Reply exactly QA_DETAIL_AUDIT_OK.',
        }]);

        expect(renderable.metadata?.summaryText).toBe('QA detail/title/tool/turn-state audit 2026-07-01. Reply exactly QA_DETAIL_AUDIT_OK.');
    });

    it('treats terminal turn projection as authoritative over legacy thinking in renderable state', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_terminal_thinking',
            seq: 4,
            lastViewedSessionSeq: 4,
            createdAt: 1,
            updatedAt: 10_000,
            meaningfulActivityAt: 9_500,
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
        expect(renderable.meaningfulActivityAt).toBe(9_500);
        expect(renderable.latestTurnStatus).toBe('completed');
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

    it('marks cache-only rows unread from ready metadata when ready seq is newer than the cursor', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_ready_unread',
            seq: 946,
            lastViewedSessionSeq: 945,
            latestReadyEventSeq: 946,
            latestReadyEventAt: 2_000,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } as any);

        expect(renderable.hasUnreadMessages).toBe(true);
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
        } as any, undefined, [{
            id: 'm-visible',
            kind: 'agent-text',
            seq: 945,
            localId: null,
            createdAt: 1,
            text: 'Visible final assistant message',
        }]);

        expect(renderable.hasUnreadMessages).toBe(false);
    });

    it('does not treat trailing connected-service auth maintenance events as unread or meaningful activity', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_auth_maintenance_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
            createdAt: 1,
            updatedAt: 10_000,
            active: true,
            activeAt: 10_000,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            latestTurnStatus: 'in_progress',
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, undefined, [
            {
                id: 'm-visible',
                kind: 'agent-text',
                seq: 945,
                localId: null,
                createdAt: 1_000,
                text: 'Visible assistant message',
            },
            {
                id: 'm-auth',
                kind: 'agent-event',
                seq: 946,
                createdAt: 9_000,
                event: {
                    type: 'connected-service-account-switch',
                    serviceId: 'openai-codex',
                    groupId: 'group-1',
                    fromProfileId: 'profile-a',
                    toProfileId: 'profile-b',
                    reason: 'usage_limit',
                },
            },
        ]);

        expect(renderable.hasUnreadMessages).toBe(false);
        expect(renderable.meaningfulActivityAt).toBe(1_000);
    });

    it('does not use raw terminal session seq when trailing connected-service auth maintenance is projected', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_terminal_auth_maintenance_tail',
            seq: 946,
            lastViewedSessionSeq: 945,
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
            latestTurnStatusObservedAt: 10_000,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any, undefined, [
            {
                id: 'm-visible',
                kind: 'agent-text',
                seq: 945,
                localId: null,
                createdAt: 1_000,
                text: 'Visible assistant message',
            },
            {
                id: 'm-auth',
                kind: 'agent-event',
                seq: 946,
                createdAt: 9_000,
                event: {
                    type: 'connected-service-account-switch',
                    serviceId: 'openai-codex',
                    groupId: 'group-1',
                    fromProfileId: 'profile-a',
                    toProfileId: 'profile-b',
                    reason: 'usage_limit',
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
        } as any, undefined, [{
            id: 'm-visible',
            kind: 'agent-text',
            seq: 945,
            localId: null,
            createdAt: 1,
            text: 'Visible assistant message',
        }]);

        expect(renderable.hasUnreadMessages).toBe(true);
    });

    it('keeps read-state actions derived from the projected session cursor', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_read',
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
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

    it('keeps read-state actions derived from projected legacy metadata', () => {
        const renderable = buildSessionListRenderableFromSession({
            id: 's_legacy_read',
            seq: 4,
            latestTurnStatus: 'completed',
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

    it('does not prefer projected pending-request counts when the transcript has a newer terminal outcome', () => {
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

        expect(renderable.hasPendingPermissionRequests).toBe(false);
        expect(renderable.hasPendingUserActionRequests).toBe(false);
    });

    it('does not mark pending requests as attention when the session is inactive', () => {
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
        expect(renderable.hasPendingUserActionRequests).toBe(false);
        expect(renderable.pendingRequestObservedAt).toBeNull();
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

    it('reuses the previous renderable when the session data is semantically identical', () => {
        const session = {
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: {
                name: 'Repo',
                summary: { text: 'Summary' },
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'pro',
                externalSessionV1: canonicalExternalSessionLink,
                systemSessionV1: { hidden: false },
            },
            metadataVersion: 4,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 5,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingVersion: 7,
            pendingCount: 8,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            optimisticThinkingAt: null,
            thinkingGraceUntil: null,
            owner: 'owner-a',
            accessLevel: 'edit' as const,
            canApprovePermissions: true,
        };

        const previous = buildSessionListRenderableFromSession(session as any);
        const next = buildSessionListRenderableFromSession(session as any, previous);

        expect(next).toBe(previous);
    });

    it('projects canonical external-session agent identity changes without providerId', () => {
        const baseSession = {
            id: 'external-agent-change',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: {
                path: '/home/u/repo',
                externalSessionV1: {
                    v: 1 as const,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome' as const, home: 'user' as const },
                },
            },
            metadataVersion: 4,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        };

        const previous = buildSessionListRenderableFromSession(baseSession as any);
        const next = buildSessionListRenderableFromSession({
            ...baseSession,
            metadata: {
                ...baseSession.metadata,
                externalSessionV1: {
                    ...baseSession.metadata.externalSessionV1,
                    agentId: 'claude',
                },
            },
        } as any, previous);

        expect(next).not.toBe(previous);
        expect(next.metadata).not.toBe(previous.metadata);
        expect(next.metadata?.externalSessionV1).toMatchObject({
            agentId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
        });
        expect(next.metadata?.externalSessionV1).not.toHaveProperty('providerId');

        const sourceChanged = buildSessionListRenderableFromSession({
            ...baseSession,
            metadata: {
                ...baseSession.metadata,
                externalSessionV1: {
                    ...baseSession.metadata.externalSessionV1,
                    agentId: 'claude',
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/codex' },
                },
            },
        } as any, next);

        expect(sourceChanged).not.toBe(next);
        expect(sourceChanged.metadata?.externalSessionV1?.source).toEqual({
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/codex',
        });
    });

    it('reuses the previous metadata object when only non-metadata session fields change', () => {
        const baseSession = {
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: {
                name: 'Repo',
                summary: { text: 'Summary' },
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                flavor: 'pro',
                externalSessionV1: canonicalExternalSessionLink,
                systemSessionV1: { hidden: false },
            },
            metadataVersion: 4,
            agentState: {
                controlledByUser: null,
                requests: {},
                completedRequests: {},
            },
            agentStateVersion: 5,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingVersion: 7,
            pendingCount: 8,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            optimisticThinkingAt: null,
            thinkingGraceUntil: null,
            owner: 'owner-a',
            accessLevel: 'edit' as const,
            canApprovePermissions: true,
        };

        const previous = buildSessionListRenderableFromSession(baseSession as any);
        const next = buildSessionListRenderableFromSession({
            ...baseSession,
            updatedAt: 3,
            presence: 3 as const,
        } as any, previous);

        expect(next).not.toBe(previous);
        expect(next.metadata).toBe(previous.metadata);
    });

    it('reuses the previous metadata object when the metadata payload is semantically identical', () => {
        const metadata = {
            name: 'Repo',
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: canonicalExternalSessionLink,
            systemSessionV1: { hidden: false },
        };

        const previous = buildSessionListRenderableMetadataComparison(metadata as any);
        const next = buildSessionListRenderableMetadataComparison(metadata as any, previous);

        expect(next).toBe(previous);
    });

    it('reuses the nested externalSessionV1 object when only unrelated metadata fields change', () => {
        const baseMetadata = {
            name: 'Repo',
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: canonicalExternalSessionLink,
            systemSessionV1: { hidden: false },
        };

        const previous = buildSessionListRenderableMetadataComparison(baseMetadata as any);
        const next = buildSessionListRenderableMetadataComparison({
            ...baseMetadata,
            summary: { text: 'Updated summary' },
        } as any, previous);

        expect(next).not.toBe(previous);
        expect(next?.externalSessionV1).toBe(previous?.externalSessionV1);
    });

    it('projects canonical pushed external-Agent observation changes into list renderables', () => {
        const workingObservation = {
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
            observedAtMs: 1_000,
            expiresAtMs: 2_000,
        } as const;
        const baseMetadata = {
            path: '/home/u/repo',
            externalSessionV1: canonicalExternalSessionLink,
            externalAgentObservationV1: workingObservation,
        };

        const previous = buildSessionListRenderableMetadataComparison(baseMetadata as any);
        const semanticallyEqual = buildSessionListRenderableMetadataComparison({
            ...baseMetadata,
            externalAgentObservationV1: { ...workingObservation },
        } as any, previous);
        const changed = buildSessionListRenderableMetadataComparison({
            ...baseMetadata,
            externalAgentObservationV1: {
                ...workingObservation,
                status: 'waiting',
            },
        } as any, previous);

        expect(previous?.externalAgentObservationV1).toEqual(workingObservation);
        expect(semanticallyEqual).toBe(previous);
        expect(changed).not.toBe(previous);
        expect(changed?.externalAgentObservationV1?.status).toBe('waiting');
    });

    it('returns the next renderable unchanged when there is no transient state to preserve', () => {
        const previous = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);
        const next = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 3,
            active: true,
            activeAt: 3,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(preserveSessionListRenderableTransientState(previous, next)).toBe(next);
    });

    it('preserves transient visibility when the previous renderable was pinned visible', () => {
        const previous = {
            ...buildSessionListRenderableFromSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
            keepVisibleWhenInactive: true,
        };
        const next = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 3,
            active: true,
            activeAt: 3,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        } as any);

        expect(preserveSessionListRenderableTransientState(previous, next)).toEqual({
            ...next,
            keepVisibleWhenInactive: true,
        });
    });

    it('returns the next renderable unchanged when transient visibility is already preserved', () => {
        const previous = {
            ...buildSessionListRenderableFromSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
            keepVisibleWhenInactive: true,
        };
        const next = {
            ...buildSessionListRenderableFromSession({
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 3,
                active: true,
                activeAt: 3,
                metadata: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 'online',
            } as any),
            keepVisibleWhenInactive: true,
        };

        expect(preserveSessionListRenderableTransientState(previous, next)).toBe(next);
    });

    it('allows the local session owner to propagate an explicit resuming marker clear', () => {
        const next = buildSessionListRenderableFromSession({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 3,
            active: true,
            activeAt: 3,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            resumingAt: null,
        } as any);
        const previous = {
            ...next,
            resumingAt: 123,
        };

        expect(preserveSessionListRenderableTransientState(previous, next, {
            preserveResumingAt: false,
        })).toBe(next);
    });
});

describe('didSessionListRenderableReachabilityPeerFieldsChange', () => {
    it('ignores active metadata-version-only updates when explicit reachability targets stay stable', () => {
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
            // No display title: exercises the transient first-user-text
            // title fallback through the aggregate.
            metadata: {
                path: '/home/u/repo',
            },
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
        const { buildTranscriptRenderableAggregate } = await import('./transcriptRenderableAggregate');
        const { session, messages } = buildTranscriptFixture();

        const fromMessages = buildSessionListRenderableFromSession(session, undefined, messages);
        const aggregate = buildTranscriptRenderableAggregate({
            messages,
            completedRequests: null,
        });
        const fromAggregate = buildSessionListRenderableFromSession(session, undefined, undefined, aggregate);

        expect(fromAggregate).toEqual(fromMessages);
        expect(fromMessages.hasPendingPermissionRequests).toBe(true);
        expect(fromMessages.hasUnreadMessages).toBe(true);
        expect(fromMessages.meaningfulActivityAt).toBe(3_000);
        expect(fromMessages.pendingRequestObservedAt).toBe(2_000);
        expect(fromMessages.metadata?.summaryText).toBe('run it');
    });

    it('does not fall back to stored-transcript reads when an aggregate is provided', async () => {
        const { buildTranscriptRenderableAggregate } = await import('./transcriptRenderableAggregate');
        const { session, messages } = buildTranscriptFixture();

        // Poison the storage bridge for this session: a stored-messages
        // fallback would surface this bogus (empty) transcript instead.
        storageState.sessionMessages[session.id] = {
            messageIdsOldestFirst: [],
            messagesById: {},
            messagesVersion: 0,
        };

        const aggregate = buildTranscriptRenderableAggregate({
            messages,
            completedRequests: null,
        });
        const fromAggregate = buildSessionListRenderableFromSession(session, undefined, undefined, aggregate);

        expect(fromAggregate.hasPendingPermissionRequests).toBe(true);
        expect(fromAggregate.pendingRequestObservedAt).toBe(2_000);
    });
});
