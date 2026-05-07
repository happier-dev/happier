import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildSessionListRenderableFromSession,
    derivePendingRequestFlagsFromAgentState,
    preserveSessionListRenderableStaleFields,
} from './sessionListRenderable';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { resolveSessionReadStateAction } from '../readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';

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
    it('projects unread state onto renderable session rows', () => {
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
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        } satisfies Session);

        expect(renderable.hasUnreadMessages).toBe(true);
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
