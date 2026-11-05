/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ segments: [] }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The desktop shell and its native commands are OS boundaries; placement and Settings stay real.
const nativeInvoke = vi.fn<(command: string, args?: Readonly<Record<string, unknown>>) => Promise<unknown>>();
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { PetsSettingsScreen } = await import('./PetsSettingsScreen');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
const { executeCommandPaletteAction } = await import('@/components/appShell/commandPalette/commandPaletteActionRuntime');
const originalState = storage.getState();
const originalAuth = getCurrentAuth();
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCurrentAuth(originalAuth); storage.setState(originalState, true); nativeInvoke.mockClear(); });

describe('pet desktop placement through real Settings Action composition', () => {
    it('admits size gestures once on release through the same Off, Ask and Allowed policy as agent edits', async () => {
        const account = await createSecretSettingsTestHarness({
            features: createRootLayoutFeaturesResponse({ features: { pets: { companion: { enabled: true } } } }),
            settings: settingsParse({ experiments: true, featureToggles: { 'pets.companion': true },
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui', 'agent'] } } },
            }),
        });
        storage.getState().applyLocalSettings({ petsCompanionSizeScale: 1 });
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><PetsSettingsScreen /></InjectedAuthProvider>);
            const executor = createDefaultActionExecutor();
            expect(await executor.execute('settings.list', { pageId: 'pets' }, {
                surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, actionCaller: { kind: 'host' },
            })).toMatchObject({ ok: true, result: { items: expect.not.arrayContaining([
                expect.objectContaining({ anchor: 'pets.desktopOverlayVisibilityMode' }),
            ]) } });
            const track = () => screen.findByTestId('settings-pets-companion-size-slider-track')!;
            const gesture = async () => {
                await act(async () => {
                    invokeTestInstanceHandler(track(), 'onLayout', { nativeEvent: { layout: { width: 200, height: 40, x: 0, y: 0 } } });
                    invokeTestInstanceHandler(track(), 'onResponderGrant', { nativeEvent: { locationX: 20, pageX: 20 } });
                });
                for (const x of [40, 70, 100, 150, 200]) {
                    await act(async () => { invokeTestInstanceHandler(track(), 'onResponderMove', { nativeEvent: { locationX: x, pageX: x } }); });
                }
            };
            const writes = vi.spyOn(getPersistenceStorage(), 'set');
            const localWrites = () => writes.mock.calls.filter(([key]) => key === 'local-settings');
            await gesture();
            expect(storage.getState().localSettings.petsCompanionSizeScale).toBe(1);
            expect(localWrites()).toHaveLength(0);
            await act(async () => { invokeTestInstanceHandler(track(), 'onResponderRelease'); });
            await vi.waitFor(() => expect(storage.getState().localSettings.petsCompanionSizeScale).toBe(1));
            expect(localWrites()).toHaveLength(0);
            const agentEdit = () => executor.execute('settings.set', { anchor: 'pets.companionSize', value: 1.2 }, {
                surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, actionCaller: { kind: 'host' },
            });
            expect(await agentEdit()).toMatchObject({ ok: false });
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui', 'agent'] } } },
            })); });
            await gesture();
            await act(async () => { invokeTestInstanceHandler(track(), 'onResponderRelease'); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(localWrites()).toHaveLength(0);
            expect(await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve')).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(storage.getState().localSettings.petsCompanionSizeScale).toBe(1.5));
            expect(localWrites()).toHaveLength(1);
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] } },
            })); });
            await act(async () => { expect(await agentEdit()).toMatchObject({ ok: true }); });
            expect(storage.getState().localSettings.petsCompanionSizeScale).toBe(1.2);
            expect(localWrites()).toHaveLength(2);
            expect(account.settingsWrites).toEqual([]);
            expect(await executor.execute('settings.set', { anchor: 'pets.desktopOverlayVisibilityMode', value: 'attentionOnly' }, {
                surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId, actionCaller: { kind: 'host' },
            })).toMatchObject({ ok: false });
            writes.mockRestore();
        } finally { standardCleanup(); await account.dispose(); }
    });

    it.each(['settings', 'palette'] as const)('admits the %s reset under Off, Ask and Allowed and keeps visibility', async surface => {
        const secureStorage = createDesktopSecureStorageBoundary();
        nativeInvoke.mockImplementation(async (command, args) => {
            if (command === 'desktop_host_get_availability') {
                return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
            }
            return secureStorage.invoke(command, args);
        });
        // Tauri's event callback registration is part of the native boundary.
        let callbackId = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: nativeInvoke, transformCallback: () => ++callbackId });
        const account = await createSecretSettingsTestHarness({
            features: createRootLayoutFeaturesResponse({ features: { pets: { companion: { enabled: true } } } }),
            settings: settingsParse({ experiments: true, featureToggles: { 'pets.companion': true },
                actionsSettingsV1: { v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } },
            }),
        });
        storage.getState().applyLocalSettings({ desktopOverlayEnabled: false });
        const originalLocalSettings = storage.getState().localSettings;
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
                {surface === 'settings' ? <PetsSettingsScreen /> : <CommandPaletteProvider><React.Fragment /></CommandPaletteProvider>}
            </InjectedAuthProvider>);
            const reset = () => surface === 'settings'
                ? screen.tree.findAll(node => node.props.testID === 'settings-pets-desktop-overlay-reset-position'
                    && typeof node.props.onPress === 'function')[0]!.props.onPress()
                : executeCommandPaletteAction({ actionId: 'ui.command_palette.invoke', input: { commandId: 'pet-reset-position' }, context: { surface: 'ui' } });
            await act(async () => { await reset(); });
            expect(storage.getState().localSettings).toEqual(originalLocalSettings);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_pet_overlay_reset_position')).toEqual([]);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_activity_overlay_reset_position')).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.invoke': { approvalRequiredSurfaces: ['ui'] } } },
            }), { version: 2 }); });
            await act(async () => { void reset(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(storage.getState().localSettings).toEqual(originalLocalSettings);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_pet_overlay_reset_position')).toEqual([]);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_activity_overlay_reset_position')).toEqual([]);
            expect(await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve')).toMatchObject({ ok: true });
            await vi.waitFor(() => {
                const artifact = account.artifacts.list()[0]!;
                const request = StoredApprovalRequestSchema.parse(JSON.parse(account.artifacts.readPlainBody(artifact.id)!));
                expect({ status: request.status, errorCode: request.execution?.errorCode })
                    .toEqual({ status: 'executed', errorCode: undefined });
            });
            expect(storage.getState().localSettings).toEqual(originalLocalSettings);
            expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_pet_overlay_reset_position')).toHaveLength(1);
            expect(nativeInvoke.mock.calls.filter(([command]) => command.startsWith('desktop_activity_overlay_'))).toEqual([]);
            await act(async () => {
                account.replaceSettings(settingsParse({ ...account.persistedSettings,
                    actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
                }), { version: 3 });
            });
            nativeInvoke.mockClear();
            await act(async () => { await reset(); });
            await vi.waitFor(() => expect(nativeInvoke.mock.calls.filter(([command]) => command === 'desktop_pet_overlay_reset_position')).toHaveLength(1));
            expect(storage.getState().localSettings).toEqual(originalLocalSettings);
            expect(nativeInvoke.mock.calls.filter(([command]) => command.startsWith('desktop_activity_overlay_'))).toEqual([]);
            expect(account.artifacts.list().map(artifact => {
                const parsed = StoredApprovalRequestSchema.safeParse(JSON.parse(account.artifacts.readPlainBody(artifact.id)!));
                return parsed.success ? { status: parsed.data.status, actionId: parsed.data.actionId } : { id: artifact.id };
            })).toEqual([{ status: 'executed', actionId: 'settings.invoke' }]);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
