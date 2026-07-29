import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { useInboxHasContent } from './useInboxHasContent';
import { renderScreen } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { SessionMessages } from '@/sync/store/domains/messages';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockUpdateAvailable = false;
let mockHasUnread = false;

vi.mock('./useUpdates', () => ({
    useUpdates: () => ({
        updateAvailable: mockUpdateAvailable,
        isChecking: false,
        checkForUpdates: async () => {},
        reloadApp: async () => {},
    }),
}));

vi.mock('./useChangelog', () => ({
    useChangelog: () => ({
        hasUnread: mockHasUnread,
        latestReleaseId: null,
        markAsRead: () => {},
    }),
}));

const originalDevFlag = (globalThis as any).__DEV__;

function createPermissionMessage(createdAt: number): Message {
    return {
        kind: 'tool-call',
        id: 'message-permission',
        localId: null,
        createdAt,
        children: [],
        tool: {
            id: 'request-permission',
            name: 'Bash',
            state: 'running',
            input: { command: 'ls' },
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
            permission: {
                id: 'request-permission',
                status: 'pending',
                kind: 'permission',
            },
        },
    };
}

function createSessionMessages(overrides: Partial<SessionMessages> = {}): SessionMessages {
    return {
        messageIdsOldestFirst: [],
        messagesById: {},
        messagesMap: {},
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: 1,
        isLoaded: true,
        ...overrides,
    };
}

describe('useInboxHasContent', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        (globalThis as any).__DEV__ = true;
        mockUpdateAvailable = false;
        mockHasUnread = false;
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRenderables: {},
            artifacts: {},
            isDataReady: true,
        } as any);
    });

    afterEach(() => {
        if (tree) {
            act(() => {
                tree?.unmount();
            });
            tree = null;
        }
        vi.restoreAllMocks();
        (globalThis as any).__DEV__ = originalDevFlag;
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRenderables: {},
            artifacts: {},
            isDataReady: true,
        } as any);
    });

    it('returns true when there are feed items', async () => {
        storage.setState({
            friends: {},
            feedItems: [{ id: 'f1' } as any],
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true when there are pending outgoing friend requests', async () => {
        storage.setState({
            friends: {
                u1: { id: 'u1', status: 'requested' },
            },
            feedItems: [],
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns false when there is no actionable content', async () => {
        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(false);
    });

    it('returns true when changelog has unread entries', async () => {
        mockHasUnread = true;

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true when there are open approval requests', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            artifacts: {
                a1: {
                    id: 'a1',
                    header: { v: 1, kind: 'approval_request.v1', title: 'Approve', approvalStatus: 'open' },
                    title: 'Approve',
                    body: undefined,
                    headerVersion: 1,
                    bodyVersion: 1,
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    isDecrypted: true,
                },
            },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true when there are online sessions with pending permission requests', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {
                s1: {
                    id: 's1',
                    active: true,
                    presence: 'online',
                    agentState: {
                        requests: {
                            r1: {
                                tool: 'bash',
                                kind: 'permission',
                                arguments: { command: 'echo hello' },
                                createdAt: 999_000,
                            },
                        },
                    },
                },
            },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('updates when an online session gains a transcript-only pending permission', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1_000,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                },
            },
            sessionMessages: {},
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;
        expect(latest).toBe(false);

        const permissionMessage = createPermissionMessage(1_000);
        act(() => {
            storage.setState({
                sessionMessages: {
                    s1: createSessionMessages({
                        messageIdsOldestFirst: [permissionMessage.id],
                        messagesById: {
                            [permissionMessage.id]: permissionMessage,
                        },
                        messagesVersion: 2,
                    }),
                },
            } as any);
        });

        expect(latest).toBe(true);
    });

    it('does not rerender for transcript changes outside the Inbox session set', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const trackedMessages = createSessionMessages();
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1_000,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    metadata: null,
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                },
            },
            sessionMessages: {
                s1: trackedMessages,
            },
        } as any);

        let renderCount = 0;
        function Test() {
            useInboxHasContent();
            renderCount += 1;
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;
        const initialRenderCount = renderCount;

        act(() => {
            storage.setState({
                sessionMessages: {
                    s1: trackedMessages,
                    unrelated: createSessionMessages({ messagesVersion: 2 }),
                },
            } as any);
        });

        expect(renderCount).toBe(initialRenderCount);
    });

    it('returns true when there are unread sessions', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {
                s1: {
                    id: 's1',
                    seq: 4,
                    lastViewedSessionSeq: 1,
                    updatedAt: 10,
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    latestTurnStatus: 'completed',
                    presence: 1,
                    metadata: null,
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                },
            },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true when an unread session only exists in the session list rows', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 4,
                    updatedAt: 10,
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                    metadata: {
                        name: 'Renderable unread',
                        path: '/Users/leeroy/renderable',
                        homeDir: '/Users/leeroy',
                    },
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: true,
                },
            },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true when an unread session only exists in a server-scoped session row cache', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRenderables: {},
            sessionListRowStateByServerId: {
                'server-b': {
                    s1: {
                        id: 's1',
                        seq: 4,
                        updatedAt: 10,
                        createdAt: 1,
                        active: false,
                        activeAt: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 1,
                        metadata: {
                            name: 'Scoped unread',
                            path: '/Users/leeroy/scoped',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                        hasUnreadMessages: true,
                    },
                },
            },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true for warm unread session rows before full data readiness', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            isDataReady: false,
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 4,
                    updatedAt: 10,
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 1,
                    metadata: {
                        name: 'Warm unread',
                        path: '/Users/leeroy/warm',
                        homeDir: '/Users/leeroy',
                    },
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    hasUnreadMessages: true,
                },
            },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

});
