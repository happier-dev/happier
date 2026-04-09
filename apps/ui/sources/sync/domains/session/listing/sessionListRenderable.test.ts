import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildSessionListRenderableFromSession,
    derivePendingRequestFlagsFromAgentState,
    preserveSessionListRenderableTransientState,
} from './sessionListRenderable';
import { buildSessionListRenderableMetadataComparison } from './sessionListRenderableMetadataComparison';

const storageState = vi.hoisted(() => ({
    sessionMessages: {} as Record<string, unknown>,
}));

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

describe('buildSessionListRenderableFromSession', () => {
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
                directSessionV1: { v: 1 as const, providerId: 'provider-a' },
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
                directSessionV1: { v: 1 as const, providerId: 'provider-a' },
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
            directSessionV1: { v: 1 as const, providerId: 'provider-a' },
            systemSessionV1: { hidden: false },
        };

        const previous = buildSessionListRenderableMetadataComparison(metadata as any);
        const next = buildSessionListRenderableMetadataComparison(metadata as any, previous);

        expect(next).toBe(previous);
    });

    it('reuses the nested directSessionV1 object when only unrelated metadata fields change', () => {
        const baseMetadata = {
            name: 'Repo',
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            directSessionV1: { v: 1 as const, providerId: 'provider-a' },
            systemSessionV1: { hidden: false },
        };

        const previous = buildSessionListRenderableMetadataComparison(baseMetadata as any);
        const next = buildSessionListRenderableMetadataComparison({
            ...baseMetadata,
            summary: { text: 'Updated summary' },
        } as any, previous);

        expect(next).not.toBe(previous);
        expect(next?.directSessionV1).toBe(previous?.directSessionV1);
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
});
