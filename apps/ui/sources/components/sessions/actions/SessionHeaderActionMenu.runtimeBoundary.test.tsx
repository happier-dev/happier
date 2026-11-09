import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { SessionReadStateSetResultV1Schema } from '@happier-dev/protocol/sessions/readState/actions';

import { createMachineFixture, createSessionFixture, createSessionAccessFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
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
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineControlTarget, useSessionMachineControlTargetState } from '@/components/sessions/model/useSessionMachineTarget';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { UNSUPPORTED_AGENT_SESSION_CAPABILITIES } from '@happier-dev/agents';

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
// Native role/event delivery is external; the shared menu and host-role decision stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

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

    it.each([
        [{ sessionCapabilities: { ...UNSUPPORTED_AGENT_SESSION_CAPABILITIES, compaction: { events: true, manual: true } } }, false],
        [{ sessionCapabilities: UNSUPPORTED_AGENT_SESSION_CAPABILITIES }, true],
        [undefined, true],
    ] as const)('keeps Compact in the incumbent menu with the owner availability and accessible disabled reason: %s', async (publication, disabled) => {
        const base = storage.getState().sessions.sess_1!;
        const session = createSessionFixture({ ...base, active: true, metadata: { ...base.metadata!, flavor: 'external/agent',
            ...(publication ? { agentRuntimeCapabilitiesV1: publication } : {}) } });
        storage.getState().applySessions([session]);
        const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
        const item = screen.findByType(DropdownMenu).props.items.find((row: { id: string }) => row.id === 'session.compact');
        expect(item).toBeTruthy();
        expect(item.disabled === true).toBe(disabled);
        if (disabled) {
            expect(item.subtitle).toBeTruthy();
            expect(item.accessibilityLabel).toContain(item.subtitle);
        }
    });

    // F-JOURNEY-UI live (390): Share pushed ?mobileSurface=collaboration but the mounted phone cockpit stayed on chat,
    // because the menu opened People through its own pane-less opener. The host Session owns that opener.
    it('keeps Share beside Give a copy and hands it to the host Session, which owns the Access destination', async () => {
        const serverId = homes.homes.projection!.id;
        const session = createSessionFixture({ ...storage.getState().sessions.sess_1!,
            metadata: { machineId: MACHINE_ID, path: '/workspace', host: 'projection.local', bot: { kind: 'bot' } },
        });
        storage.setState({ sessions: { [session.id]: session } });
        const target = { serverId, sessionId: session.id };
        const selectedByHost: string[] = [];
        const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session}
            collaborationHeader={{ target, compact: false }} destinationsInMenu
            onSelectExtraItem={(actionId) => { selectedByHost.push(actionId); return actionId === 'header.share'; }} />);
        const menu = screen.findByType(DropdownMenu);
        const rows: ReadonlyArray<{ id: string; category?: string; subtitle?: string }> = menu.props.items;
        const shareIndex = rows.findIndex(row => row.id === 'header.share');
        expect(shareIndex).toBeGreaterThanOrEqual(0);
        expect(rows[shareIndex + 1]?.id).toBe('header.giveBotCopy');
        expect(rows[shareIndex + 1]?.category).toBe(rows[shareIndex]?.category);
        expect(rows[shareIndex + 1]?.subtitle).toBeTruthy();
        expect(rows.some(row => row.id === 'header.openCollaboration')).toBe(true);
        await act(async () => { menu.props.onSelect('header.share'); });
        expect(selectedByHost).toEqual(['header.share']);
        expect(vi.mocked(router.push)).not.toHaveBeenCalled();
    });

    // REAL-USER-PASS-2 G9: Give a copy… closed the menu and showed nothing for 5–10 s while the draft was made.
    it('keeps Give a copy… open with its pending row until the template draft settles', async () => {
        const serverId = homes.homes.projection!.id;
        const session = createSessionFixture({ ...storage.getState().sessions.sess_1!,
            metadata: { machineId: MACHINE_ID, path: '/workspace', host: 'projection.local', bot: { kind: 'bot' } },
        });
        storage.setState({ sessions: { [session.id]: session } });
        const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session}
            collaborationHeader={{ target: { serverId, sessionId: session.id }, compact: false }} destinationsInMenu />);
        const giveCopy = () => (screen.findByType(DropdownMenu).props.items as ReadonlyArray<{ id: string; loading?: boolean;
            keepMenuOpen?: boolean }>).find(row => row.id === 'header.giveBotCopy');
        expect(giveCopy()?.keepMenuOpen).toBe(true);
        act(() => { screen.findByType(DropdownMenu).props.onSelect('header.giveBotCopy'); });
        expect(giveCopy()?.loading).toBe(true);
        await vi.waitFor(() => expect(giveCopy()?.loading).toBeUndefined());
        await screen.unmount();
    });

    it('offers the shared window presentation from the Session header menu', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => ({
            activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
        }) });
        const session = storage.getState().sessions.sess_1!;
        const state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: session.id } }, pinned: false, preview: false });
        const workspace = {
            active: true, state, canGoBack: false, canGoForward: false,
            desktopPresentation: { serverId: homes.homes.projection!.id, accountId: 'header-account', layoutId: 'main' },
            openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        } satisfies WorkspaceNavigationContextValue;
        try {
            const screen = await renderScreen(<WorkspaceNavigationProvider value={workspace}>
                <SessionHeaderActionMenu sessionId={session.id} session={session} />
            </WorkspaceNavigationProvider>);
            await vi.waitFor(() => {
                expect(screen.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toContain('workspace.open.window');
            });
        } finally { vi.unstubAllGlobals(); }
    });

    it('updates mounted Machine controls through presence alone without replacing inventory', async () => {
        const serverId = homes.homes.projection!.id;
        const machine = storage.getState().machines[MACHINE_ID]!;
        const session = storage.getState().sessions.sess_1!;
        storage.setState({
            sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
            ordinarySessionListMembershipByServerId: { [serverId]: [session.id] },
        });
        observeMachinePresenceForTest({ serverId, accountId: 'header-account' }, [machine.id]);
        const before = storage.getState();
        let renders = 0;
        const targets = await renderHook(() => {
            renders += 1;
            return { control: useSessionMachineControlTarget(session.id, serverId),
                state: useSessionMachineControlTargetState(session.id, serverId) };
        });
        try {
            expect(targets.getCurrent().control).toMatchObject({ machineId: machine.id, basePath: '/workspace' });
            const mountedRenders = renders;
            const other = createMachineFixture({ id: 'unrelated-presence-machine' });
            for (let beat = 1; beat <= 5; beat += 1) {
                await act(async () => {
                    publishMachineActivity(machine, { active: true, activeAt: machine.activeAt + beat }, []);
                    publishMachineActivity(other, { active: false, activeAt: other.activeAt + beat }, []);
                });
            }
            expect(renders).toBe(mountedRenders);
            await act(async () => {
                const root = storage.getState();
                publishMachineActivity(machine, { active: false, activeAt: machine.activeAt + 5 }, []);
                expect(storage.getState()).toBe(root);
            });
            expect(targets.getCurrent()).toMatchObject({ control: null, state: { status: 'unavailable' } });
            expect(storage.getState().machines).toBe(before.machines);
            await act(async () => {
                const root = storage.getState();
                publishMachineActivity(machine, { active: true, activeAt: machine.activeAt + 6 }, []);
                expect(storage.getState()).toBe(root);
            });
            expect(targets.getCurrent().control).toMatchObject({ machineId: machine.id, basePath: '/workspace' });
            expect(storage.getState().machines).toBe(before.machines);
        } finally { await targets.unmount(); }
    });

    it('loads the routed Session machine when the focused Home has the same Session id', async () => {
        const serverId = homes.homes.projection!.id;
        const focusedServerId = homes.homes.focused!.id;
        const machine = storage.getState().machines[MACHINE_ID]!;
        const focusedMachine = createMachineFixture({ id: 'focused-machine', active: true });
        const session = createSessionFixture({ ...storage.getState().sessions.sess_1!, active: false,
            metadata: { machineId: MACHINE_ID, path: '/projection', host: 'projection.local', flavor: 'codex' } });
        const focusedSession = createSessionFixture({ id: session.id, serverId: focusedServerId, active: false,
            metadata: { machineId: focusedMachine.id, path: '/focused', host: 'focused.local', flavor: 'codex' } });
        storage.setState({ sessions: { [session.id]: focusedSession }, machines: { [focusedMachine.id]: focusedMachine },
            machineListByServerId: { [serverId]: [machine], [focusedServerId]: [focusedMachine] },
            ordinarySessionListMembershipByServerId: { [serverId]: [session.id], [focusedServerId]: [session.id] },
            sessionListRowsByServerId: {
                [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) },
                [focusedServerId]: { [session.id]: buildSessionListRenderableFromSession(focusedSession) },
            } });
        observeMachinePresenceForTest({ serverId, accountId: 'header-account' }, [machine.id]);
        observeMachinePresenceForTest({ serverId: focusedServerId, accountId: 'header-account' }, [focusedMachine.id]);
        const targets = await renderHook(() => ({ bare: useSessionReachableMachineTarget(session.id),
            routed: useSessionReachableMachineTarget(session.id, serverId),
            control: useSessionMachineControlTarget(session.id, serverId) }));
        expect(targets.getCurrent()).toMatchObject({ bare: { machineId: focusedMachine.id, basePath: '/focused' },
            routed: { machineId: machine.id, basePath: '/projection' }, control: { machineId: machine.id, basePath: '/projection' } });
        await targets.unmount();
        const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
        try {
            const reads = () => boundary.socket.emitWithAck.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL);
            await vi.waitFor(() => expect(reads().length).toBeGreaterThan(0));
            expect(reads().map(([, request]) => request)).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: expect.stringMatching(new RegExp(`^${MACHINE_ID}:`)) }),
            ]));
            expect(reads().map(([, request]) => request)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ method: expect.stringMatching(new RegExp(`^${focusedMachine.id}:`)) }),
            ]));
        } finally { await screen.unmount(); }
    });

    it('opens reports for read-only offline sessions with their scoped account and no public prefill', async () => {
        const serverId = homes.homes.projection!.id;
        const session = createSessionFixture({ ...storage.getState().sessions.sess_1!,
            active: false, presence: 0, access: createSessionAccessFixture('view'),
        });
        storage.setState({ sessions: { [session.id]: session } });
        vi.mocked(router.push).mockClear();
        const screen = await renderScreen(<SessionHeaderActionMenu sessionId={session.id} session={session} />);
        const dropdown = screen.findByType(DropdownMenu);
        expect(dropdown.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'header.reportIssue' })]));
        await act(async () => { dropdown.props.onSelect('header.reportIssue'); });
        await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith({
            pathname: '/settings/report-issue', params: { sessionId: session.id, serverId, accountId: 'header-account' },
        }));
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

    it('keeps the closed header uncommitted while a streaming turn rewrites its Session row', async () => {
        const session = createSessionFixture({
            ...storage.getState().sessions.sess_1!, active: true, thinking: true, seq: 1, lastViewedSessionSeq: 1,
        });
        storage.getState().applySessions([session]);
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="header" onRender={() => { commits += 1; }}>
            <SessionHeaderActionMenu sessionId={session.id} session={session} />
        </React.Profiler>);
        await flushHookEffects({ cycles: 5, turns: 2 });
        const hasAction = (id: string) => screen.findByType(DropdownMenu).props.items
            .some((item: { id: string }) => item.id === id);
        expect(storage.getState().sessionListRowsByServerId[homes.homes.projection!.id]?.[session.id]).toBeDefined();
        commits = 0;
        // Each streamed checkpoint advances the row's activity facts without changing any Action.
        for (let index = 2; index <= 6; index += 1) {
            await act(async () => {
                storage.getState().applySessions([{ ...session, thinking: index % 2 === 0, thinkingAt: index, activeAt: index, updatedAt: index }]);
            });
        }
        expect(commits).toBe(0);
        expect(hasAction(SESSION_ACTION_STOP_ID)).toBe(true);
        await act(async () => { storage.getState().applySessions([{ ...session, updatedAt: 7,
            access: { ...session.access!, capabilities: { ...session.access!.capabilities, stopSession: false } },
        }]); });
        expect(hasAction(SESSION_ACTION_STOP_ID)).toBe(false);
        await screen.unmount();
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

        // A reusable carrier alone is not the retained global conversation.
        await act(async () => {
            storage.setState({ sessions: { [session.id]: session, [carrier.id]: { ...carrier, active: true } } });
        });
        await flushHookEffects();
        expect(teleportItem()).toBeUndefined();
        // The exact retained global admission owns teleport discoverability.
        await act(async () => {
            voiceSessionBindingStore.getState().bind({
                adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                conversationSessionId: carrier.id,
                conversationSessionAddress: { serverId: carrierHome, sessionId: carrier.id },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: session.serverId!, sessionId: session.id }, updatedAt: 2,
            });
        });
        await flushHookEffects();
        expect(teleportItem()).toBeDefined();
        // Connection restoration may publish presence; merely discovering the
        // Voice action must not dispatch an RPC to the Agent.
        expect(boundary.socket.emitWithAck.mock.calls.filter(([event]) => event === SOCKET_RPC_EVENTS.CALL)).toEqual([]);
    });
});
