import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildActivityBadgeState } from './buildActivityBadgeState';
import type { StorageState } from '@/sync/store/types';

const storageState = vi.hoisted(() => ({
    sessionMessages: {} as Record<string, unknown>,
}));

const readMockStorageState = () => storageState as unknown as StorageState;

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

beforeEach(async () => {
    storageState.sessionMessages = {};
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(readMockStorageState);
});

describe('buildActivityBadgeState', () => {
    it('counts unread session-list renderables before full session hydration completes', () => {
        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 0,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                    hasUnreadMessages: true,
                } as any,
            ],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 1,
            showNonNumericDot: false,
        });
    });

    it('does not count undecryptable unread session-list renderables', () => {
        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 4,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                    metadataUnavailable: true,
                    hasUnreadMessages: true,
                } as any,
            ],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 0,
            showNonNumericDot: false,
        });
    });

    it('counts a session once even when multiple attention reasons are active', () => {
        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 5,
                    lastViewedSessionSeq: 3,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    pendingCount: 4,
                    metadata: { path: '', host: '' },
                } as any,
            ],
            numericInboxCount: 2,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 3,
            showNonNumericDot: false,
        });
    });

    it('does not count pending permission/user-action requests for inactive sessions', () => {
        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 5,
                    active: false,
                    lastViewedSessionSeq: 5,
                    pendingPermissionRequestCount: 2,
                    pendingUserActionRequestCount: 1,
                    pendingCount: 0,
                    metadata: { path: '', host: '' },
                } as any,
            ],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 0,
            showNonNumericDot: false,
        });
    });

    it('does not count stale pending requests when the transcript already marked them canceled', () => {
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

        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 5,
                    active: true,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    metadata: { path: '', host: '' },
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            req1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: { q: 'continue?' },
                                createdAt: 100,
                            },
                        },
                        completedRequests: null,
                    },
                } as any,
            ],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 0,
            showNonNumericDot: false,
        });
    });

    it('counts hydrated pending transcript requests for active sessions before a fresh pending fetch completes', () => {
        storageState.sessionMessages = {
            s1: {
                messages: [
                    {
                        kind: 'tool-call',
                        id: 'm-tool-pending-1',
                        localId: null,
                        createdAt: 100,
                        children: [],
                        tool: {
                            id: 'req1',
                            name: 'Bash',
                            state: 'running',
                            input: { command: 'ls' },
                            createdAt: 100,
                            permission: {
                                id: 'req1',
                                status: 'pending',
                                kind: 'user_action',
                            },
                        },
                    },
                ],
            },
        };

        const state = buildActivityBadgeState({
            sessions: [
                {
                    id: 's1',
                    seq: 5,
                    active: true,
                    lastViewedSessionSeq: 5,
                    pendingCount: 0,
                    metadata: { path: '', host: '' },
                    agentState: {
                        controlledByUser: null,
                        requests: {},
                        completedRequests: null,
                    },
                } as any,
            ],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: false,
        });

        expect(state).toEqual({
            count: 1,
            showNonNumericDot: false,
        });
    });

    it('shows a non-numeric dot when only dot-only inbox attention exists', () => {
        const state = buildActivityBadgeState({
            sessions: [],
            numericInboxCount: 0,
            hasNonNumericInboxAttention: true,
        });

        expect(state).toEqual({
            count: 0,
            showNonNumericDot: true,
        });
    });
});
