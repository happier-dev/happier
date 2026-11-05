/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { flushHookEffects } from '@/dev/testkit';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { resolveDesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/settings/desktop' }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// OS window inventory and event registration are the genuine native SDK boundary.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const originalState = storage.getState();
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); storage.setState(originalState, true); });

describe('Notch declared settings composition', () => {
    it('contracts the page and admits device edits through Off, Ask and Allowed without Account writes', async () => {
        const baseline = settingsParse({ actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        const account = await createSecretSettingsTestHarness({ settings: baseline });
        vi.stubGlobal('isTauri', true);
        const secureStorage = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_host_get_availability') return Promise.resolve({
                activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
            });
            return secureStorage.invoke(command, args);
        } });
        storage.getState().applyLocalSettings({ ...localSettingsDefaults, desktopOverlayEnabled: true });
        let commits = 0;
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const localWrites = () => writes.mock.calls.filter(([key]) => key === 'local-settings');
        try {
            const screen = await renderScreen(<React.Profiler id="notch-settings" onRender={() => { commits++; }}>
                <DesktopOverlaySettingsSection />
            </React.Profiler>);
            const choices = () => screen.tree.findAllByType(SegmentedChoiceItem);
            expect(choices().map(row => row.props.testID)).toEqual([
                'settings-desktop-overlay-dock', 'settings-desktop-overlay-idle',
                'settings-desktop-overlay-visibility-mode', 'settings-desktop-bot-conversation-presentation',
            ]);
            const mode = () => choices().find(row => row.props.testID === 'settings-desktop-overlay-visibility-mode')!;
            await act(async () => { await mode().props.onChange('active_sessions'); });
            expect(storage.getState().localSettings.desktopOverlayVisibilityMode).toBe('attention_only');
            expect(localWrites()).toHaveLength(0);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline, actionsSettingsV1: { v: 1,
                actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } } })); });
            let pending: Promise<unknown>;
            await act(async () => { pending = mode().props.onChange('active_sessions'); });
            await flushHookEffects();
            expect(storage.getState().localSettings.desktopOverlayVisibilityMode).toBe('attention_only');
            expect(localWrites()).toHaveLength(0);
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await act(async () => { await pending!; });
            expect(storage.getState().localSettings.desktopOverlayVisibilityMode).toBe('active_sessions');
            expect(localWrites()).toHaveLength(1);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline, actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] } } })); });
            await act(async () => { await choices().find(row => row.props.testID === 'settings-desktop-bot-conversation-presentation')!
                .props.onChange('window'); });
            expect(storage.getState().localSettings.desktopBotConversationPresentation).toBe('window');
            expect(localWrites()).toHaveLength(2);
            const uiPolicy = resolveDesktopOverlayPolicy(storage.getState().localSettings);
            const executor = createDefaultActionExecutor();
            for (const value of ['overlay', 'window']) {
                await act(async () => { expect(await executor.execute('settings.set', {
                    anchor: 'desktop.botConversationPresentation', value,
                }, { surface: 'agent', authority: 'account_automation', serverId: account.scope.serverId,
                    actionCaller: { kind: 'host' } })).toMatchObject({ ok: true }); });
            }
            expect(localWrites()).toHaveLength(4);
            expect(resolveDesktopOverlayPolicy(storage.getState().localSettings)).toEqual(uiPolicy);
            expect(account.settingsWrites).toEqual([]);
            await flushHookEffects(); commits = 0;
            await act(async () => { storage.getState().applyLocalSettings({ desktopPetOverlayLocked: true }); });
            expect(commits).toBe(0);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
