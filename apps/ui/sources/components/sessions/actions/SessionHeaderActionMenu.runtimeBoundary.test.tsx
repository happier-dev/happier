import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createMachineFixture, createSessionFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
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
        toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {},
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

    beforeEach(async () => {
        previousState = storage.getState();
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
            route: ({ path }) => {
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === `/v1/machines/${MACHINE_ID}`) return Response.json({
                    machine: { id: MACHINE_ID, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
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
        homes?.dispose();
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
        const button = screen.findByTestId(`session-header-plugin-action-${MENU_ID}`);
        expect(button).not.toBeNull();
        expect(button!.props.accessibilityRole).toBe('button');
        expect(button!.props.accessibilityLabel).toBe('Preview');
        expect(button!.props.accessibilityState).toEqual({ disabled: false });
        await act(async () => {
            button!.props.onPress();
            await vi.waitFor(() => expect(actionRequests()).toHaveLength(2));
        });
        await flushHookEffects();
        expectRequest();
        expect(homes.requests).toEqual(expect.arrayContaining([expect.objectContaining({
            home: 'projection', accountId: 'header-account', path: `/v1/machines/${MACHINE_ID}`,
        })]));
        expect(ioSpy).toHaveBeenCalledWith(homes.homes.projection!.serverUrl, expect.objectContaining({
            auth: expect.objectContaining({ token: expect.any(String), clientType: 'user-scoped', clientPurpose: 'scoped-rpc' }),
        }));
        expect(modalAlert).not.toHaveBeenCalled();
        expect(modalShow).not.toHaveBeenCalled();
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
        storage.setState({
            settings: settingsParse({ voice }),
            sessions: { [session.id]: session, [carrier.id]: carrier },
        });
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
        expect(boundary.socket.emitWithAck).not.toHaveBeenCalled();
    });
});
