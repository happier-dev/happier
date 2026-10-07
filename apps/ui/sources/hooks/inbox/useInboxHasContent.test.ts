import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { useInboxHasContent } from './useInboxHasContent';
import { renderScreen as renderScreenBase } from '@/dev/testkit/render/renderScreen';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { MMKV } from 'react-native-mmkv';
import { createReducer } from "@happier-dev/session-core/reducer";
import type { SessionMessages } from '@/sync/store/domains/messages';
import { InboxSummaryProvider } from './useInboxSummary';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalDevFlag = (globalThis as any).__DEV__;
const initialState = storage.getInitialState();
let homeAId: string;
let homeBId: string;

function setFriendsEnabled(enabled: boolean) {
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
        features: { workflows: { enabled: false }, automations: { enabled: false }, social: { friends: { enabled } } },
        capabilities: { social: { friends: { allowUsername: true, requiredIdentityProviderId: null } } },
    }) } });
}

function renderScreen(node: React.ReactNode) {
    return renderScreenBase(React.createElement(InboxSummaryProvider, null, node));
}

function createPermissionMessage(createdAt: number): NormalizedMessage {
    return {
        id: 'message-permission',
        localId: null,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-call',
            id: 'request-permission',
            name: 'Bash',
            input: { command: 'ls', permissionId: 'request-permission', status: 'pending' },
            description: null,
            uuid: 'permission-uuid',
            parentUUID: null,
        }],
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

function withOrdinarySession(session: Partial<Session>) {
    const sessionId = session.id ?? 's1';
    const scopedSession = createSessionFixture({ activeAt: session.active ? Date.now() : 1, ...session, id: sessionId, serverId: homeAId });
    return {
        sessions: { [sessionId]: scopedSession },
        sessionListRowsByServerId: { [homeAId]: { [sessionId]: buildSessionListRenderableFromSession(scopedSession) } },
        ordinarySessionListMembershipByServerId: { [homeAId]: [sessionId] },
    };
}

describe('useInboxHasContent', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(async () => {
        (globalThis as any).__DEV__ = true;
        storage.setState(initialState, true);
        homeAId = (await upsertAndActivateServer({ serverUrl: 'https://inbox-content-a.example.test', name: 'Inbox A' })).id;
        homeBId = (await upsertServerProfile({ serverUrl: 'https://inbox-content-b.example.test', name: 'Inbox B' })).id;
        setFriendsEnabled(true);
        storage.setState({
            profile: { ...initialState.profile, username: 'inbox-reader' },
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            isDataReady: true,
        });
    });

    afterEach(async () => {
        if (tree) {
            act(() => {
                tree?.unmount();
            });
            tree = null;
        }
        vi.restoreAllMocks();
        (globalThis as any).__DEV__ = originalDevFlag;
        deleteServerFeaturesSnapshot();
        await removeServerProfile(homeAId);
        await removeServerProfile(homeBId);
        storage.setState(initialState, true);
    });

    it('does not light the inbox for passive feed history', async () => {
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

        expect(latest).toBe(false);
    });

    it('does not light the inbox for outgoing friend requests', async () => {
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

        expect(latest).toBe(false);
    });

    it('returns true for incoming friend requests that need a response', async () => {
        storage.setState({
            friends: {
                u1: { id: 'u1', status: 'pending' },
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

    it('does not light the inbox for friend requests the Inbox screen cannot show', async () => {
        // The screen hides the friends section behind the same gate. A dot the
        // user can never clear by opening the Inbox is worse than no dot.
        setFriendsEnabled(false);
        storage.setState({
            friends: {
                u1: { id: 'u1', status: 'pending' },
            },
            feedItems: [],
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(false);
    });

    it('does not light the inbox for friend requests before the friends identity is ready', async () => {
        storage.setState({ profile: { ...storage.getState().profile, username: null, linkedProviders: [] } });
        storage.setState({
            friends: {
                u1: { id: 'u1', status: 'pending' },
            },
            feedItems: [],
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(false);
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

    it('does not light the inbox for changelog history', async () => {
        const readStoredString = MMKV.prototype.getString;
        vi.spyOn(MMKV.prototype, 'getString').mockImplementation(function (this: MMKV, key) {
            return key === 'changelog-last-viewed-release-id'
                ? 'earlier-release'
                : readStoredString.call(this, key);
        });

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(false);
    });

    it('returns true when there are open approval requests', async () => {
        const request = ApprovalRequestV1Schema.parse({
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'system' },
            actionId: 'session.list',
            actionArgs: {},
            summary: 'Approve',
        });
        storage.setState({
            friends: {},
            feedItems: [],
            artifacts: {
                a1: {
                    id: 'a1',
                    header: buildApprovalRequestArtifactHeaderV1(request),
                    title: 'Approve',
                    body: JSON.stringify(request),
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
            ...withOrdinarySession({
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
            }),
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
            ...withOrdinarySession({
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
            }),
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
            // Transcript ingestion owns the summary projection; the Inbox does
            // not subscribe to detailed messages merely to maintain its badge.
            storage.getState().applyMessages('s1', [permissionMessage]);
        });

        expect(latest).toBe(true);
    });

    it('does not rerender for transcript changes outside the Inbox session set', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const trackedMessages = createSessionMessages();
        storage.setState({
            friends: {},
            feedItems: [],
            ...withOrdinarySession({
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
            }),
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

    it('returns true when a completed unseen session is ready for review', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            ...withOrdinarySession({
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
                latestReadyEventSeq: 4,
                latestReadyEventAt: 10,
                presence: 1,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            }),
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('does not light the inbox for transcript unread while a session is still working', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            ...withOrdinarySession({
                id: 's1',
                seq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 10,
                createdAt: 1,
                active: true,
                activeAt: 10,
                thinking: true,
                thinkingAt: 10,
                latestTurnStatus: 'in_progress',
                presence: 1,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            }),
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(false);
    });

    it('ignores unread rows that are not members of the ordinary list corpus', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRowsByServerId: {
                [homeAId]: {
                    s1: buildSessionListRenderableFromSession(createSessionFixture({
                        id: 's1',
                        serverId: homeAId,
                        seq: 4,
                        lastViewedSessionSeq: 1,
                        updatedAt: 10,
                        createdAt: 1,
                        active: false,
                        activeAt: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 1,
                        metadata: {
                            name: 'Query-only unread',
                            host: 'inbox-content-a.example.test',
                            path: '/Users/leeroy/query-only',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                    })),
                },
            },
            ordinarySessionListMembershipByServerId: { [homeAId]: [] },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(false);
    });

    it('returns true when a completed unseen session only exists in a server-scoped session row cache', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            sessionListRowsByServerId: {
                [homeBId]: {
                    s1: buildSessionListRenderableFromSession(createSessionFixture({
                        id: 's1',
                        serverId: homeBId,
                        seq: 4,
                        lastViewedSessionSeq: 1,
                        latestReadyEventSeq: 4,
                        latestReadyEventAt: 9,
                        updatedAt: 10,
                        createdAt: 1,
                        active: false,
                        activeAt: 1,
                        thinking: false,
                        thinkingAt: 0,
                        latestTurnStatus: 'completed',
                        lastTurnCompletedAt: 9,
                        presence: 1,
                        metadata: {
                            name: 'Scoped unread',
                            host: 'inbox-content-b.example.test',
                            path: '/Users/leeroy/scoped',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                    })),
                },
            },
            ordinarySessionListMembershipByServerId: { [homeBId]: ['s1'] },
        } as any);

        let latest: boolean | null = null;
        function Test() {
            latest = useInboxHasContent();
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Test))).tree;

        expect(latest).toBe(true);
    });

    it('returns true for warm completed unseen session rows before full data readiness', async () => {
        storage.setState({
            friends: {},
            feedItems: [],
            sessions: {},
            isDataReady: false,
            sessionListRowsByServerId: {
                [homeAId]: {
                    s1: buildSessionListRenderableFromSession(createSessionFixture({
                        id: 's1',
                        serverId: homeAId,
                        seq: 4,
                        lastViewedSessionSeq: 1,
                        latestReadyEventSeq: 4,
                        latestReadyEventAt: 9,
                        updatedAt: 10,
                        createdAt: 1,
                        active: false,
                        activeAt: 1,
                        thinking: false,
                        thinkingAt: 0,
                        latestTurnStatus: 'completed',
                        lastTurnCompletedAt: 9,
                        presence: 1,
                        metadata: {
                            name: 'Warm unread',
                            host: 'inbox-content-a.example.test',
                            path: '/Users/leeroy/warm',
                            homeDir: '/Users/leeroy',
                        },
                        metadataVersion: 0,
                        agentStateVersion: 0,
                    })),
                },
            },
            ordinarySessionListMembershipByServerId: { [homeAId]: ['s1'] },
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
