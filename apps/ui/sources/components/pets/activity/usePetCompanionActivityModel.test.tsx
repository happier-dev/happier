import * as React from 'react';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture as createBaseSessionFixture, renderHook, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Message } from "@happier-dev/session-core/messages";
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';
import { createReducer } from "@happier-dev/session-core/reducer";
import type { SessionMessages } from '@/sync/store/domains/messages';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { usePetCompanionActivityModel } from './usePetCompanionActivityModel';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let serverId = '';
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function createSessionFixture(...args: Parameters<typeof createBaseSessionFixture>) {
    // Runtime-fallback cases retain the canonical owner's supported pre-viewer input shape.
    return { ...createBaseSessionFixture(...args), serverId };
}

function createSessionMessages(messages: readonly Message[]): SessionMessages {
    const messagesById: Record<string, Message> = {};
    const messageIdsOldestFirst: string[] = [];
    for (const message of messages) {
        messagesById[message.id] = message;
        messageIdsOldestFirst.push(message.id);
    }

    return {
        messageIdsOldestFirst,
        messagesById,
        messagesMap: messagesById,
        reducerState: createReducer(),
        latestThinkingMessageId: null,
        latestThinkingMessageActivityAtMs: null,
        latestReadyEventSeq: null,
        latestReadyEventAt: null,
        messagesVersion: messages.length,
        isLoaded: true,
    };
}

function buildSessionListProjection(sessions: readonly ReturnType<typeof createSessionFixture>[]) {
    const rows = Object.fromEntries(
        sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)]),
    );
    return {
        sessionListRowsByServerId: { [serverId]: rows },
        ordinarySessionListMembershipByServerId: { [serverId]: sessions.map((session) => session.id) },
        sessionListIndexByServerId: {
            [serverId]: sessions.map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: serverId,
                serverName: 'Server A',
            })),
        },
    };
}

describe('usePetCompanionActivityModel', () => {
    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(4_000);
        await homes.reset();
        serverId = await homes.addHome({ name: 'Server A', serverUrl: 'https://pet-activity.test',
            accountId: 'pet-owner', currentAccount: true });
        homes.answer(serverId, '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        await loadSyncSingletonForTests();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://pet-activity.test',
            accountId: 'pet-owner', request: homes.request });
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        saveAccountSettings({ serverId, accountId: 'pet-owner' }, settingsParse({}), 1);
        await vi.waitFor(() => expect(storage.getState().concurrentSessionListCacheByServerId[serverId]?.listObservation?.phase).toBe('error'));
    });

    afterEach(async () => {
        setScreenSharingPrivacyActive(false);
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
        await homes.reset();
        vi.restoreAllMocks();
    });

    it('omits recording-private Sessions from companion activity and restores them when sharing ends', async () => {
        const previousState = storage.getState();
        const sessions = ['private-pet', 'public-pet'].map(id => createSessionFixture({ id, encryptionMode: 'plain',
            active: true, activeAt: 4_000, thinking: true, thinkingAt: 4_000,
            metadata: { path: '/repo', host: 'host', name: id },
        }));
        try {
            storage.setState({ isDataReady: true, sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
                ...buildSessionListProjection(sessions), sessionMessages: {},
            });
            storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
            storage.getState().setSessionTagAssignmentsOptimistic(serverId, 'private-pet', ['private']);
            setScreenSharingPrivacyActive(true);
            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent().trayItems.map(item => item.sessionId)).toEqual(['public-pet']);
            expect(JSON.stringify(hook.getCurrent())).not.toContain('private-pet');
            await act(async () => { setScreenSharingPrivacyActive(false); });
            await flushHookEffects();
            expect(hook.getCurrent().trayItems.map(item => item.sessionId).sort()).toEqual(['private-pet', 'public-pet']);
            await hook.unmount();
        } finally { storage.setState(previousState, true); }
    });

    it.each([false, true])('honors Home-restricted pet delivery with a permitted control (permitted=%s)', async permitted => {
        const previousState = storage.getState();
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        saveAccountSettings({ serverId, accountId: 'pet-owner' }, settingsParse({
            attentionDeliveryPolicyV1: { channels: { desktop_overlay: { enabled: permitted } } },
        }), 2);
        const session = createSessionFixture({ id: 'home-restricted', encryptionMode: 'plain',
            active: true, activeAt: 4_000, thinking: true, thinkingAt: 4_000,
            metadata: { path: '/private', host: 'private-host', name: 'Prohibited pet title' },
        });
        try {
            storage.setState({ isDataReady: true, sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: { [session.id]: createSessionMessages([{
                    kind: 'agent-text', id: 'private-text', localId: null, createdAt: 4_000,
                    text: 'Prohibited transcript', isThinking: false,
                }]) },
            });
            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent().trayItems).toHaveLength(permitted ? 1 : 0);
            if (permitted) expect(hook.getCurrent().trayItems[0]?.title).toBe('Prohibited pet title');
            else expect(JSON.stringify(hook.getCurrent())).not.toContain('Prohibited');
            expect(JSON.stringify(hook.getCurrent())).not.toContain('Prohibited transcript');
            await hook.unmount();
        } finally { storage.setState(previousState, true); }
    });

    it.each([
        { encryptionMode: 'e2ee' as const, encryptedContentAvailability: undefined, readable: false },
        { encryptionMode: 'e2ee' as const, encryptedContentAvailability: 'ready' as const, readable: true },
        { encryptionMode: 'plain' as const, encryptedContentAvailability: undefined, readable: true },
    ])('gates retained pet copy by canonical availability: $encryptionMode/$encryptedContentAvailability', async ({ encryptionMode, encryptedContentAvailability, readable }) => {
        const previousState = storage.getState();
        const base = createSessionFixture({
            id: 'private-pet', encryptionMode, encryptedContentAvailability,
            active: true, presence: 'online', seq: 2, lastViewedSessionSeq: 0,
            createdAt: 1_000, updatedAt: 2_000, activeAt: 2_000,
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: 2_000,
            metadata: { path: '/private/path', host: 'private-host', name: 'Private retained title' },
        });
        const session = { ...base, viewer: createSessionOwnerViewerFixture(base) };
        const message: Message = {
            kind: 'agent-text', id: 'private-message', localId: null, createdAt: 2_000,
            text: 'Private retained transcript', isThinking: false,
        };
        try {
            storage.setState((state) => ({
                ...state, isDataReady: true, sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: { [session.id]: createSessionMessages([message]) },
            }));
            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            const model = hook.getCurrent();
            await hook.unmount();
            expect(model.trayItems).toHaveLength(1);
            expect(model.trayItems[0]?.address).toEqual({ serverId: serverId, sessionId: session.id });
            if (readable) {
                expect(model.trayItems[0]?.title).toBe('Private retained title');
                expect(model.trayItems[0]?.subtitle).toBe(model.trayItems[0]?.contextLine);
            } else {
                expect(JSON.stringify(model)).not.toContain('Private retained');
                expect(model.trayItems[0]?.subtitle).toBe(model.trayItems[0]?.contextLine);
                expect(model.trayItems[0]?.contextLine).toContain('Server A');
            }
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not commit activity when unrelated storage state changes', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'stable-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                React.useLayoutEffect(() => { renderCount += 1; });
                return usePetCompanionActivityModel();
            }, {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeUnrelatedUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    settings: state.settings,
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not commit activity when an unrelated hidden system session changes', async () => {
        const previousState = storage.getState();
        const visibleSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'visible-waiting-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: 3_000,
            agentState: {
                controlledByUser: null,
                requests: {
                    action_1: {
                        tool: 'Read',
                        kind: 'user_action',
                        arguments: { path: '/tmp/visible-waiting-session' },
                        createdAt: 3_000,
                    },
                },
            },
            thinking: false,
            thinkingAt: 0,
        });
        const hiddenSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'hidden-system-update-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/hidden-system-update-session',
                host: 'test-host',
                summary: { text: 'Hidden system session', updatedAt: 2_000 },
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [visibleSession.id]: visibleSession,
                    [hiddenSession.id]: hiddenSession,
                },
                ...buildSessionListProjection([visibleSession]),
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                React.useLayoutEffect(() => { renderCount += 1; });
                return usePetCompanionActivityModel();
            }, {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toMatchObject({
                state: 'needsYou',
                sessionId: visibleSession.id,
            });
            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeHiddenUpdate = renderCount;
            const hiddenSessionMetadata = hiddenSession.metadata;
            if (!hiddenSessionMetadata) {
                throw new Error('Expected hidden session metadata fixture');
            }
            const updatedHiddenSession = {
                ...hiddenSession,
                updatedAt: 9_000,
                pendingCount: 2,
                metadata: {
                    ...hiddenSessionMetadata,
                    summary: { text: 'Hidden system session changed', updatedAt: 9_000 },
                },
            };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        [visibleSession.id]: visibleSession,
                        [updatedHiddenSession.id]: updatedHiddenSession,
                    },
                    ...buildSessionListProjection([visibleSession]),
                }));
            });

            expect(renderCount).toBe(renderCountBeforeHiddenUpdate);
            expect(hook.getCurrent().sessionId).toBe(visibleSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('publishes fallback session activity for meaningful activity without surfacing runtime attention', async () => {
        vi.mocked(Date.now).mockReturnValue(130_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'fallback-meaningful-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 129_000,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 129_000,
            meaningfulActivityAt: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                React.useLayoutEffect(() => { renderCount += 1; });
                return usePetCompanionActivityModel();
            }, {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toMatchObject({
                state: 'working',
                sessionId: session.id,
            });
            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeBookkeepingUpdate = renderCount;
            const bookkeepingSession = { ...session, updatedAt: 3_000 };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { [bookkeepingSession.id]: bookkeepingSession },
                    ...buildSessionListProjection([bookkeepingSession]),
                }));
            });

            expect(renderCount).toBe(renderCountBeforeBookkeepingUpdate);

            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeMeaningfulActivityUpdate = renderCount;
            const meaningfulSession = {
                ...bookkeepingSession,
                meaningfulActivityAt: 129_000,
            };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { [meaningfulSession.id]: meaningfulSession },
                    ...buildSessionListProjection([meaningfulSession]),
                }));
            });

            expect(renderCount).toBeGreaterThan(renderCountBeforeMeaningfulActivityUpdate);
            expect(hook.getCurrent()).toMatchObject({
                state: 'working',
                sessionId: session.id,
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('publishes renderable-only activity for meaningful activity without surfacing runtime attention', async () => {
        vi.mocked(Date.now).mockReturnValue(130_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'renderable-meaningful-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 129_000,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 129_000,
            meaningfulActivityAt: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRowsByServerId: {
                    [serverId]: {
                        [session.id]: buildSessionListRenderableFromSession(session),
                    },
                },
                ordinarySessionListMembershipByServerId: { [serverId]: [session.id] },
                sessionListIndexByServerId: {
                    [serverId]: [
                        { type: 'session', sessionId: session.id, serverId: serverId, serverName: 'Server A' },
                    ],
                },
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                React.useLayoutEffect(() => { renderCount += 1; });
                return usePetCompanionActivityModel();
            }, {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            expect(hook.getCurrent()).toMatchObject({
                state: 'working',
                sessionId: session.id,
            });
            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeBookkeepingUpdate = renderCount;
            const bookkeepingSession = { ...session, updatedAt: 3_000 };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            [bookkeepingSession.id]: buildSessionListRenderableFromSession(bookkeepingSession),
                        },
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeBookkeepingUpdate);

            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeMeaningfulActivityUpdate = renderCount;
            const meaningfulSession = {
                ...bookkeepingSession,
                meaningfulActivityAt: 129_000,
            };

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRowsByServerId: {
                        ...state.sessionListRowsByServerId,
                        [serverId]: {
                            [meaningfulSession.id]: buildSessionListRenderableFromSession(meaningfulSession),
                        },
                    },
                }));
            });

            expect(renderCount).toBeGreaterThan(renderCountBeforeMeaningfulActivityUpdate);
            expect(hook.getCurrent()).toMatchObject({
                state: 'working',
                sessionId: session.id,
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('reads zero transcript records or commits as own and unrelated transcripts grow', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'scoped-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
        });
        const unrelatedMessage: Message = {
            kind: 'agent-text',
            id: 'unrelated-message',
            localId: null,
            createdAt: 3_000,
            text: 'Background session streamed a token',
        };

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                React.useLayoutEffect(() => { renderCount += 1; });
                return usePetCompanionActivityModel();
            }, {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });
            await vi.waitFor(() => expect(hook.getCurrent().sessionId).not.toBeNull());
            await flushHookEffects();
            const renderCountBeforeUnrelatedTranscriptUpdate = renderCount;

            let messageReads = 0;
            for (const length of [128, 4096]) {
                const messages = createSessionMessages(Array.from({ length }, (_, index) => ({ ...unrelatedMessage, id: `message-${index}` })));
                const records = messages.messagesById;
                Object.defineProperty(messages, 'messagesById', { enumerable: true, get: () => { messageReads++; return records; } });
                Object.defineProperty(messages, 'messagesMap', { enumerable: true, get: () => { messageReads++; return records; } });
                await act(async () => {
                    storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
                        [session.id]: messages, 'unrelated-session': messages } }));
                });
            }
            expect(messageReads).toBe(0);

            expect(renderCount).toBe(renderCountBeforeUnrelatedTranscriptUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not treat a read online row with historical thinkingAt as running activity', async () => {
        vi.mocked(Date.now).mockReturnValue(12_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'historical-thinking-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 10_000,
            activeAt: 10_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 10_000,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'quiet',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not surface old unread sessions as pet waiting activity without projected runtime attention', async () => {
        vi.mocked(Date.now).mockReturnValue(900_000_000);
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'old-unread-session',
            active: true,
            seq: 5,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'quiet',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses an unhydrated canonical permission projection as pet waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'renderable-only-unread',
            active: true,
            seq: 4,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            thinking: false,
            thinkingAt: 0,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 3_000,
            metadata: {
                path: '/tmp/renderable-only-unread',
                host: 'test-host',
                summary: { text: 'Renderable unread session', updatedAt: 3_000 },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {},
                sessionListRowsByServerId: {
                    [serverId]: {
                        [session.id]: buildSessionListRenderableFromSession(session),
                    },
                },
                ordinarySessionListMembershipByServerId: { [serverId]: [session.id] },
                sessionListIndexByServerId: {
                    [serverId]: [
                        { type: 'session', sessionId: session.id, serverId: serverId, serverName: 'Server A' },
                    ],
                },
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'needsYou',
                sessionId: session.id,
                trayItems: [expect.objectContaining({
                    sessionId: session.id,
                    activity: 'needsYou',
                })],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('excludes hidden system sessions from companion activity', async () => {
        const previousState = storage.getState();
        const voiceSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'voice-system-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            pendingCount: 1,
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/voice-system-session',
                host: 'test-host',
                summary: { text: 'Voice conversation (system)', updatedAt: 3_000 },
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        });
        const visibleSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'visible-session',
            active: true,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 2,
            pendingCount: 0,
            pendingUserActionRequestCount: 1,
            pendingRequestObservedAt: Date.now(),
            agentState: {
                controlledByUser: null,
                requests: {
                    action_1: {
                        tool: 'Read',
                        kind: 'user_action',
                        arguments: { path: '/tmp/visible-session' },
                        createdAt: Date.now(),
                    },
                },
            },
            thinking: false,
            thinkingAt: 0,
            metadata: {
                path: '/tmp/visible-session',
                host: 'test-host',
                summary: { text: 'Visible session', updatedAt: 2_000 },
            },
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: {
                    [voiceSession.id]: voiceSession,
                    [visibleSession.id]: visibleSession,
                },
                ...buildSessionListProjection([voiceSession, visibleSession]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'needsYou',
                sessionId: visibleSession.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: visibleSession.id,
                    }),
                ],
            });
            expect(hook.getCurrent().trayItems.map((item) => item.sessionId)).not.toContain(voiceSession.id);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not use queued pending input as waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'stale-queued-session',
            active: true,
            seq: 2,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 2,
            pendingCount: 1,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'quiet',
                sessionId: session.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('updates running activity when an online working session goes offline', async () => {
        vi.mocked(Date.now).mockReturnValue(4_000);
        const previousState = storage.getState();
        const onlineSession = createSessionFixture({
            encryptionMode: 'plain',
            id: 'presence-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 3_000,
            activeAt: 3_000,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 3_000,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [onlineSession.id]: onlineSession },
                ...buildSessionListProjection([onlineSession]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'working',
                sessionId: onlineSession.id,
            });

            const offlineSession = {
                ...onlineSession,
                presence: 3_500,
            };
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { [offlineSession.id]: offlineSession },
                    ...buildSessionListProjection([offlineSession]),
                }));
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'quiet',
                sessionId: onlineSession.id,
                trayItems: [],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('uses unhydrated agent-state requests as waiting activity', async () => {
        const previousState = storage.getState();
        const session = createSessionFixture({
            encryptionMode: 'plain',
            id: 'agent-state-request-session',
            active: true,
            seq: 1,
            createdAt: 1_000,
            updatedAt: 2_000,
            activeAt: 2_000,
            lastViewedSessionSeq: 1,
            pendingCount: 0,
            agentState: {
                controlledByUser: null,
                requests: {
                    request_1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'git status' },
                        createdAt: Date.now(),
                    },
                },
            },
            agentStateVersion: 2,
            thinking: false,
            thinkingAt: 0,
        });

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                sessions: { [session.id]: session },
                ...buildSessionListProjection([session]),
                sessionMessages: {},
            }));

            const hook = await renderHook(() => usePetCompanionActivityModel(), {
                wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={false}>{children}</ActivityPersonalSessionMembershipProvider>,
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toMatchObject({
                state: 'needsYou',
                sessionId: session.id,
                trayItems: [
                    expect.objectContaining({
                        sessionId: session.id,
                        activity: 'needsYou',
                    }),
                ],
            });

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
