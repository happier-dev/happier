import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { SessionReadStateSetResultV1Schema } from '@happier-dev/protocol/sessions/readState/actions';

import { createMachineFixture, createSessionFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SESSION_ACTION_MARK_READ_ID, SESSION_ACTION_MARK_UNREAD_ID, SESSION_ACTION_STOP_ID } from './sessionActionIds';
import { SessionHeaderActionMenu } from './SessionHeaderActionMenu';
import { resolvePluginSessionHeaderActionPresentations } from './pluginHeaderActions';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';

vi.hoisted(async () => {
    const { mkdirSync, realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cache = join(realpathSync('node_modules'), '.cache', 'ci03-header-plugin-actions');
    mkdirSync(cache, { recursive: true });
    vi.stubEnv('TMPDIR', cache);
});

const ioSpy = vi.hoisted(() => vi.fn());
const modalShow = vi.hoisted(() => vi.fn(() => 'modal-id'));
const modalAlert = vi.hoisted(() => vi.fn());

// Native UI adapters and HTTP/Socket.IO are external boundaries. The menu,
// projection, Home/store readers, ask-first policy and scoped RPC remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { show: modalShow, alert: modalAlert },
}).module);
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));

const MACHINE_ID = 'machine-projection';
const OCCURRENCE_ID = 'acme-preview-occurrence-7';
const MENU_ID = 'plugin-ui:sessionHeaderAction:acme.preview:run-preview';

function createProjection() {
    return normalizePluginUiProjection({
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {
            'acme.preview/run': {
                id: 'run', pluginId: 'acme.preview', occurrenceId: OCCURRENCE_ID,
                title: 'Preview', scopes: ['session'], surfaces: ['ui'],
                execution: { target: 'daemon' }, placementBindings: ['detailsPanel'],
                dangerLevel: 'safe', available: true,
            },
        },
          resourcesById: {}, settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.preview': {
                        id: 'translations:acme.preview', pluginId: 'acme.preview', occurrenceId: OCCURRENCE_ID,
                        contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Preview' } },
                    },
                    'sessionHeaderAction:acme.preview:run-preview': {
                        id: 'sessionHeaderAction:acme.preview:run-preview', pluginId: 'acme.preview', occurrenceId: OCCURRENCE_ID,
                        contributionKind: 'sessionHeaderAction', descriptorId: 'run-preview',
                        title: { key: 'title', fallback: 'Preview' },
                        command: { kind: 'executeAction', action: { pluginId: 'acme.preview', localId: 'run' } },
                    },
                },
            },
        },
        diagnostics: [],
    });
}

describe('SessionHeaderActionMenu real runtime boundaries', () => {
    let homes: Awaited<ReturnType<typeof serveActionHomes>>;
    let boundary: ReturnType<typeof createSocketIoBoundaryStub>;
    let previousState: ReturnType<typeof storage.getState>;
    let readStateReply: (() => Response) | null;

    beforeEach(async () => {
        previousState = storage.getState();
        readStateReply = null;
        voiceSessionBindingStore.setState({
            bindingsByConversationSessionId: {}, runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {},
        });
        resetVoiceSessionStoreForTests();
        boundary = createSocketIoBoundaryStub();
        ioSpy.mockReturnValue(boundary.socket);
        boundary.socket.emitWithAck.mockResolvedValue({ ok: true, result: { ok: true, result: { opened: true } } });
        homes = await serveActionHomes({
            homes: [
                { key: 'projection', serverUrl: 'https://projection.home.test', accountId: 'header-account' },
                { key: 'focused', serverUrl: 'https://focused.home.test', accountId: 'header-account' },
            ],
            route: ({ path, body }) => {
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v2/sessions/sess_1/read-state' && readStateReply) return readStateReply();
                if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(body,
                    id => id === MACHINE_ID ? createPlainMachineRowFixture({ id, accountId: 'header-account' }) : null);
                if (path === `/v1/machines/${MACHINE_ID}`) return Response.json({
                    machine: createPlainMachineRowFixture({ id: MACHINE_ID, accountId: 'header-account' }),
                });
                return undefined;
            },
        });
        const homeId = homes.homes.projection!.id;
        const machine = createMachineFixture({ id: MACHINE_ID });
        const session = createSessionFixture({
            id: 'sess_1', serverId: homeId,
            metadata: { machineId: MACHINE_ID, path: '/workspace', host: 'projection.local' },
        });
        storage.setState({
            isDataReady: true,
            settings: settingsParse({}),
            sessions: { [session.id]: session }, machines: { [machine.id]: machine },
            machineListByServerId: { [homeId]: [machine] },
            sessionListRowsByServerId: {}, sessionListIndexByServerId: {},
            ordinarySessionListMembershipByServerId: {}, concurrentSessionListCacheByServerId: {},
        });
    });

    afterEach(async () => {
        standardCleanup();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        resetServerFeaturesClientForTests();
        await homes?.dispose();
        storage.setState(previousState, true);
        voiceSessionBindingStore.setState({
            bindingsByConversationSessionId: {}, runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {},
        });
        resetVoiceSessionStoreForTests();
        ioSpy.mockReset();
        modalShow.mockClear();
        modalAlert.mockClear();
    });

    // Moved from the legacy handoff suite: one normalized descriptor must have
    // the same admitted occurrence and omitted input through both UI arms.
    it('dispatches one normalized executeAction descriptor through both overflow and direct header arms', async () => {
        const projection = createProjection();
        const scopedLaunchFacts = {
            serverId: homes.homes.projection!.id, machineId: MACHINE_ID,
            generation: 7, interactionEnabled: true,
        } as const;
        const presentations = resolvePluginSessionHeaderActionPresentations({
            projection, locale: 'en', policyContext: { platform: 'web', channel: 'internal' },
            scopedLaunchFacts,
        });
        expect(presentations).toHaveLength(1);
        const session = storage.getState().sessions.sess_1!;
        const renderMenu = (placement: 'overflow' | 'direct') => <SessionHeaderActionMenu
            sessionId={session.id} session={session} pluginUiProjection={projection}
            pluginHeaderActions={presentations} pluginHeaderActionPlacement={placement}
            pluginUiScopedLaunchFacts={scopedLaunchFacts}
        />;
        const screen = await renderScreen(renderMenu('overflow'));
        const dropdown = screen.findByType(DropdownMenu);
        expect(dropdown.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: MENU_ID, title: 'Preview' })]));

        const actionRequests = () => boundary.socket.emitWithAck.mock.calls.filter(([event, request]) => (
            event === SOCKET_RPC_EVENTS.CALL && typeof request === 'object' && request !== null
            && 'method' in request && request.method === `${MACHINE_ID}:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`
        ));
        const expectRequest = () => {
            const request = actionRequests().at(-1)?.[1];
            expect(request).toMatchObject({
                method: `${MACHINE_ID}:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`,
                params: {
                    machineId: MACHINE_ID, expectedContributorOccurrenceId: OCCURRENCE_ID,
                    qualifiedActionId: 'acme.preview/run', sessionId: session.id, executionSurface: 'ui',
                },
            });
            if (!request || typeof request !== 'object' || !('params' in request)
                || !request.params || typeof request.params !== 'object') throw new Error('Missing Action transport payload');
            expect(Object.hasOwn(request.params, 'input')).toBe(false);
        };
        await act(async () => {
            dropdown.props.onSelect(MENU_ID);
            await vi.waitFor(() => expect(actionRequests()).toHaveLength(1));
        });
        await flushHookEffects();
        expectRequest();

        await screen.update(renderMenu('direct'));
        const button = screen.findHostByTestId(`session-header-plugin-action-${MENU_ID}`);
        expect(button).not.toBeNull();
        expect(button!.props.role).toBe('button');
        expect(button!.props.accessibilityLabel).toBe('Preview');
        expect(button!.props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
        await act(async () => {
            button!.props.onPress();
            await vi.waitFor(() => expect(actionRequests()).toHaveLength(2));
        });
        await flushHookEffects();
        expectRequest();
        expect(homes.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            home: 'projection', accountId: 'header-account', path: '/v1/machines/read-batch',
            body: expect.objectContaining({ machineIds: expect.arrayContaining([MACHINE_ID]) }),
        })]));
        expect(ioSpy).toHaveBeenCalledWith(homes.homes.projection!.serverUrl, expect.objectContaining({
            auth: expect.objectContaining({ token: expect.any(String), clientType: 'user-scoped', clientPurpose: 'scoped-rpc' }),
        }));
        expect(modalAlert).not.toHaveBeenCalled();
        expect(modalShow).not.toHaveBeenCalled();
    });

    it('keeps the open Stop control available as streaming Session facts advance', async () => {
        await withPopoverWebGlobals(async () => {
            let session = createSessionFixture({
                ...storage.getState().sessions.sess_1!, active: true, thinking: true,
            });
            storage.setState({ sessions: { [session.id]: session } });
            const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
            try {
                const trigger = screen.findByTestId('session-header-action-menu-trigger');
                expect(trigger).not.toBeNull();
                await act(async () => {
                    trigger!.props.onClick({ stopPropagation() {} });
                });
                await flushHookEffects({ frames: 1 });
                expect(screen.findByType(DropdownMenu).props.open).toBe(true);

                const dropdown = screen.findByType(DropdownMenu);
                const stop = () => screen.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === SESSION_ACTION_STOP_ID);
                expect(stop()).toMatchObject({ id: SESSION_ACTION_STOP_ID });
                expect(stop().disabled).not.toBe(true);
                for (let seq = 2; seq <= 4; seq++) {
                    session = { ...session, seq, thinkingAt: seq, updatedAt: seq };
                    await act(async () => { storage.setState({ sessions: { [session.id]: session } }); });
                    await screen.update(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
                    expect(screen.findByType(DropdownMenu)).toBe(dropdown);
                    expect(dropdown.props.open).toBe(true);
                    expect(stop().disabled).not.toBe(true);
                }
            } finally {
                await screen.unmount();
            }
        });
    });

    it('keeps the header uncommitted for text-only revisions and refreshes real read and action facts', async () => {
        const session = createSessionFixture({
            ...storage.getState().sessions.sess_1!, active: true,
            seq: 1, lastViewedSessionSeq: 1, latestTurnStatus: 'in_progress', latestReadyEventSeq: null,
        });
        const chunk = (text: string, seq = 1, updatedAtMs = seq): NormalizedMessage => ({
            id: `answer-${seq}`, localId: `answer-${seq}`, createdAt: seq, seq,
            role: 'agent', isSidechain: false,
            content: [{ type: 'text', text, uuid: `answer-${seq}`, parentUUID: null }],
            meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
                segmentLocalId: `answer-${seq}`, segmentState: 'streaming', startedAtMs: seq, updatedAtMs } },
        });
        storage.getState().applySessions([session]);
        storage.getState().applyMessages(session.id, [chunk('Starting answer')]);
        storage.getState().applyMessagesLoaded(session.id);
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="header" onRender={() => { commits += 1; }}>
            <SessionHeaderActionMenu sessionId={session.id} session={session} />
        </React.Profiler>);
        await flushHookEffects({ cycles: 5, turns: 2 });
        const hasAction = (id: string) => screen.findByType(DropdownMenu).props.items
            .some((item: { id: string }) => item.id === id);
        expect(hasAction(SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);
        const initialVersion = storage.getState().sessionMessages[session.id]!.messagesVersion;
        commits = 0;
        for (let index = 0; index < 5; index += 1) {
            await act(async () => { storage.getState().applyMessages(session.id, [chunk(`Streaming text ${index}`, 1, index + 2)]); });
        }
        expect(storage.getState().sessionMessages[session.id]!.messagesVersion).toBe(initialVersion + 5);
        expect(commits).toBe(0);
        expect(hasAction(SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);

        await act(async () => { storage.getState().applyMessages(session.id, [chunk('A genuinely new unread answer', 2)]); });
        expect(commits).toBeGreaterThan(0);
        expect(hasAction(SESSION_ACTION_MARK_READ_ID)).toBe(true);
        await act(async () => { storage.getState().applySessions([{ ...session, seq: 2, lastViewedSessionSeq: 2 }]); });
        expect(hasAction(SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);
        expect(hasAction(SESSION_ACTION_MARK_READ_ID)).toBe(false);

        expect(hasAction(SESSION_ACTION_STOP_ID)).toBe(true);
        await act(async () => { storage.getState().applySessions([{ ...session, seq: 2, lastViewedSessionSeq: 2,
            access: { ...session.access!, capabilities: { ...session.access!.capabilities, stopSession: false } },
        }]); });
        expect(hasAction(SESSION_ACTION_STOP_ID)).toBe(false);

        await act(async () => { storage.getState().applyMessages(session.id, [chunk('Another unread answer', 3)]); });
        expect(hasAction(SESSION_ACTION_MARK_READ_ID)).toBe(true);
        // The Home's cursor has advanced again by invocation time; the Action
        // must use that fresh result rather than sending the rendered cursor.
        readStateReply = () => Response.json({ success: true, ...SessionReadStateSetResultV1Schema.parse({
            state: 'read', lastViewedSessionSeq: 4, didChange: true,
        }) });
        await act(async () => {
            screen.findByType(DropdownMenu).props.onSelect(SESSION_ACTION_MARK_READ_ID);
            await vi.waitFor(() => expect(homes.requests.filter(request => request.method === 'POST'
                && request.path === '/v2/sessions/sess_1/read-state')).toHaveLength(1));
            await vi.waitFor(() => expect(storage.getState().sessionListRowsByServerId[homes.homes.projection!.id]?.[session.id]?.lastViewedSessionSeq).toBe(4));
        });
        await flushHookEffects();
        expect(homes.requests.find(request => request.method === 'POST'
            && request.path === '/v2/sessions/sess_1/read-state')).toMatchObject({
            home: 'projection', accountId: 'header-account', body: { state: 'read' },
        });
        expect(storage.getState().sessionListRowsByServerId[homes.homes.projection!.id]?.[session.id]?.lastViewedSessionSeq).toBe(4);
        expect(hasAction(SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);
        expect(hasAction(SESSION_ACTION_MARK_READ_ID)).toBe(false);
    });

    it('does not infer a global voice conversation from a local binding alone', async () => {
        const voice = {
            providerId: 'local_conversation',
            ui: { scopeDefault: 'global', surfaceLocation: 'auto', activityFeedEnabled: false },
            providers: {
                local_conversation: { schemaVersion: 1, config: {
                    conversationMode: 'agent',
                    agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
                } },
            },
        };
        const carrierHome = homes.homes.focused!.id;
        const carrier = createSessionFixture({
            id: 'carrier-s1', serverId: carrierHome, active: false, updatedAt: 1,
            metadata: { path: '/voice', host: 'focused.local', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        });
        const session = {
            ...storage.getState().sessions.sess_1!,
            metadata: { path: '/workspace', host: 'projection.local' },
        };
        // Keep the Home's bootstrap echo consistent with the locally selected Voice settings.
        homes.replaceAccountSettings('focused', { settings: { voice }, version: 2 });
        storage.getState().applySettingsLocal({ voice: settingsParse({ voice }).voice });
        storage.setState({ sessions: { [session.id]: session, [carrier.id]: carrier } });
        // A live per-Session binding is not the global control identity, and
        // an inactive carrier is not an active reusable Voice system session.
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation', controlSessionId: session.id,
            conversationSessionId: carrier.id,
            conversationSessionAddress: { serverId: carrierHome, sessionId: carrier.id },
            transcriptMode: 'synthetic',
            targetSessionAddress: { serverId: session.serverId!, sessionId: session.id }, updatedAt: 1,
        });
        const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
        const teleportItem = () => screen.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === 'voice.teleport');
        expect(teleportItem()).toBeUndefined();

        // Sensitivity: the same settings and binding must permit discoverability
        // once the real persisted carrier becomes eligible for global reuse.
        await act(async () => {
            storage.setState({ sessions: { [session.id]: session, [carrier.id]: { ...carrier, active: true } } });
        });
        await flushHookEffects();
        expect(teleportItem()).toBeDefined();
        // Connection restoration may publish presence; merely discovering the
        // Voice action must not dispatch an RPC to the Agent.
        expect(boundary.socket.emitWithAck.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toEqual([]);
    });
});
