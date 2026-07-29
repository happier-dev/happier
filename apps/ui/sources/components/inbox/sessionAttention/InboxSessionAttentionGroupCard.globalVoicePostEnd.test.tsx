import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createSessionFixture,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildInboxSessionState } from '@/hooks/inbox/buildInboxSessionState';
import { InboxSessionAttentionGroupCard } from './InboxSessionAttentionGroupCard';

const NOW_MS = 1_000_000;
const SESSION_ID = 'global-voice-after-end';
const REQUEST_ID = 'permission-after-end';
const permissionRpc = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    sessionListRenderables: {} as Record<string, unknown>,
}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        TouchableOpacity: 'TouchableOpacity',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPush,
        },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const {
        createStorageModuleStub,
        createUseSettingMock,
    } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useMachine: () => null,
        useSetting: createUseSettingMock({
            values: {
                toolViewDetailLevelDefault: 'title',
            },
        }),
        storage: {
            getState: () => ({
                sessions: storageState.sessions,
                sessionListRenderables: storageState.sessionListRenderables,
                sessionListIndexByServerId: {
                    // Hidden system sessions are intentionally absent from the ordinary list.
                    'server-a': [],
                },
                concurrentSessionListCacheByServerId: {},
                clearSessionOptimisticThinking: vi.fn(),
                clearSessionThinkingGrace: vi.fn(),
                applySessions: vi.fn(),
                updateSessionPermissionMode: vi.fn(),
            }),
        },
    });
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope', () => ({
    sessionRpcWithPreferredSessionScope: (args: unknown) => permissionRpc(args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://a.example.test',
        generation: 1,
    }),
}));

function createPendingPostEndSession(): Session {
    return createSessionFixture({
        id: SESSION_ID,
        serverId: 'server-a',
        seq: 4,
        lastViewedSessionSeq: 4,
        active: true,
        activeAt: NOW_MS - 100,
        updatedAt: NOW_MS - 10,
        presence: 'online',
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: NOW_MS - 10,
        metadata: {
            name: 'Global Voice session',
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            flavor: 'codex',
            systemSessionV1: {
                v: 1,
                key: 'voice_conversation',
                hidden: true,
            },
        },
        agentState: {
            controlledByUser: null,
            requests: {
                [REQUEST_ID]: {
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                },
            },
            completedRequests: {},
        },
    });
}

function createActivitySource(session: Session): ActivityAttentionSource {
    return {
        isDataReady: true,
        sessionsById: { [session.id]: session },
        sessionListRenderablesById: {
            [session.id]: buildSessionListRenderableFromSession(session),
        },
        sessionListIndexByServerId: {
            // Hidden system sessions are intentionally absent from the ordinary list.
            'server-a': [],
        },
        concurrentSessionListCacheByServerId: {},
        serverProfilesById: {
            'server-a': {
                id: 'server-a',
                name: 'Server A',
                serverUrl: 'https://a.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
        },
        activeServer: {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
    };
}

describe('global Voice post-End permission custody', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storageState.sessions = {};
        storageState.sessionListRenderables = {};
        permissionRpc.mockResolvedValue(undefined);
        routerPush.mockResolvedValue(undefined);
    });

    it.each([
        {
            decision: 'approve',
            actionTestId: 'permission-footer.allow',
            approved: true,
            rpcDecision: 'approved',
        },
        {
            decision: 'deny',
            actionTestId: 'permission-footer.deny',
            approved: false,
            rpcDecision: 'denied',
        },
    ] as const)(
        'keeps the post-End hidden-session permission actionable for $decision',
        async ({ actionTestId, approved, rpcDecision }) => {
            const session = createPendingPostEndSession();
            storageState.sessions = { [session.id]: session };
            storageState.sessionListRenderables = {
                [session.id]: buildSessionListRenderableFromSession(session),
            };
            const activity = buildActivityOverviewFromSource({
                source: createActivitySource(session),
                nowMs: NOW_MS,
                directActionsEnabled: true,
            });
            const inbox = buildInboxSessionState({
                sessions: [session],
                sessionRows: [],
                nowMs: NOW_MS,
            });

            expect(activity.candidates).toEqual([
                expect.objectContaining({
                    sessionId: SESSION_ID,
                    route: `/session/${SESSION_ID}?serverId=server-a`,
                }),
            ]);
            expect(inbox.sessionsNeedingAttention).toHaveLength(1);

            const attention = inbox.sessionsNeedingAttention[0]!;
            const screen = await renderScreen(
                <InboxSessionAttentionGroupCard
                    session={attention.session}
                    permissionRequests={attention.pendingPermissions}
                    userActionRequests={attention.pendingUserActions}
                />,
            );

            await pressTestInstanceAsync(
                screen.find((node) => node.props.accessibilityLabel === 'inbox.openSession'),
                'post-End hidden Voice session open action',
            );

            expect(routerPush).toHaveBeenCalledTimes(1);
            expect(routerPush).toHaveBeenCalledWith(
                `/session/${SESSION_ID}?serverId=server-a`,
            );

            await screen.pressByTestIdAsync(actionTestId);

            expect(screen.findByTestId('permission-footer.action-error')).toBeNull();
            expect(permissionRpc).toHaveBeenCalledTimes(1);
            expect(permissionRpc).toHaveBeenCalledWith({
                sessionId: SESSION_ID,
                method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
                payload: {
                    id: REQUEST_ID,
                    approved,
                    decision: rpcDecision,
                },
            });
            expect(routerPush).toHaveBeenCalledTimes(1);
        },
    );
});
