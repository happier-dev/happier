import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderHook, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storage';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('reanimated-color-picker', async () =>
    (await import('@/dev/testkit/mocks/reanimatedColorPicker')).createReanimatedColorPickerMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The bridge is the OS/window boundary; Settings admission remains real.
vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: async () => null,
    listenDesktopActivityOverlayWindowState: async () => () => {},
}));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useGlassAppearance } = await import('@/components/ui/glass/useGlassAppearance');
const { KeyboardShortcutsSettingsView } = await import('@/components/settings/keyboard/KeyboardShortcutsSettingsView');
const { TranscriptSettingsView } = await import('@/components/settings/session/TranscriptSettingsView');
const { SessionListViewOptionsButton } = await import('@/components/sessions/shell/sessionListChrome');
const { SessionListLayoutIntentProvider, useSessionListLayoutChoice } = await import('@/hooks/session/sessionListLayoutIntent');
const { DesktopOverlaySettingsSection } = await import('@/components/settings/desktop/DesktopOverlaySettingsSection');
const { SourceControlSettingsView } = await import('@/components/settings/sourceControl/SourceControlSettingsView');
const originalState = storage.getState();
const originalAuth = getCurrentAuth();
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); setCurrentAuth(originalAuth); storage.setState(originalState, true); });

describe('compound Settings controls through declared Action ingress', () => {
    it('admits the mounted SCM confirmation choices and preserves the other remote preference', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'manual',
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        try {
            const screen = await renderSettingsView(<SourceControlSettingsView />);
            const toggle = (kind: 'Pulling' | 'Pushing', value: boolean) => screen.findRowByTitle(
                `settingsSourceControl.remoteConfirmation.confirmBefore${kind}.title`,
            )!.props.rightElement.props.onValueChange(value);
            await act(async () => { toggle('Pulling', false); });
            expect(account.persistedSettings.scmRemoteConfirmPolicy).toBe('always');
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { toggle('Pulling', false); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.persistedSettings.scmRemoteConfirmPolicy).toBe('always');
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings.scmRemoteConfirmPolicy).toBe('push_only'));
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { toggle('Pushing', false); });
            await vi.waitFor(() => expect(account.persistedSettings.scmRemoteConfirmPolicy).toBe('never'));
            expect(account.persistedSettings.scmPushRejectPolicy).toBe('manual');
            expect(account.artifacts.list()).toHaveLength(1);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('retires placement controls while retaining the selected notch dock', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        storage.setState({ localSettings: { ...localSettingsDefaults, desktopOverlayEnabled: true, desktopOverlayDock: 'floating' } });
        const screen = await renderSettingsView(<DesktopOverlaySettingsSection />);
        expect(screen.findRowByTitle('settingsDesktop.overlay.resetPositionTitle')).toBeNull();
        expect(screen.findAll(node => node.props.testIDPrefix === 'settings-desktop-overlay-placement-mode')).toEqual([]);
        expect(storage.getState().localSettings.desktopOverlayDock).toBe('floating');
    });
    it('admits list layout before yielding its visit intent and preserves unrelated list preferences', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ sessionListLayoutV1: 'projects',
            hideInactiveSessions: true,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        let layout: string | undefined;
        function Probe() { layout = useSessionListLayoutChoice(); return <SessionListViewOptionsButton />; }
        try {
            const screen = await renderSettingsView(<SessionListLayoutIntentProvider choice="recent_activity"><Probe /></SessionListLayoutIntentProvider>);
            const choose = (value: string) => screen.findAll(node => typeof node.props.onSelect === 'function'
                && node.props.items?.some((item: { id: string }) => item.id === 'layout:projects'))[0]!.props.onSelect(value);
            await act(async () => { choose('layout:projects'); });
            expect(account.persistedSettings.sessionListLayoutV1).toBe('projects');
            expect(layout).toBe('recent_activity');
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { choose('layout:projects'); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(layout).toBe('recent_activity');
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await vi.waitFor(() => expect(layout).toBe('projects'));
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { choose('layout:recent_activity'); });
            await vi.waitFor(() => expect(layout).toBe('recent_activity'));
            expect(account.persistedSettings.hideInactiveSessions).toBe(true);
            expect(account.artifacts.list()).toHaveLength(1);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('admits the mounted thinking choice under Off, Ask and Allowed and keeps tool preferences', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ sessionThinkingDisplayMode: 'tool',
            sessionThinkingInlinePresentation: 'summary', transcriptShowToolCalls: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        try {
            const screen = await renderSettingsView(<TranscriptSettingsView />);
            const choose = (value: string) => screen.findAll(node => node.props.testID === 'settings-session-thinking-display'
                && node.props.rightElement?.props.onChange)[0]!.props.rightElement.props.onChange(value);
            await act(async () => { choose('inline_full'); });
            expect(account.persistedSettings.sessionThinkingDisplayMode).toBe('tool');
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { choose('inline_full'); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.persistedSettings.sessionThinkingDisplayMode).toBe('tool');
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full' }));
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { choose('hidden'); });
            await vi.waitFor(() => expect(account.persistedSettings.sessionThinkingDisplayMode).toBe('hidden'));
            expect(account.persistedSettings.transcriptShowToolCalls).toBe(false);
            expect(account.persistedSettings.sessionThinkingInlinePresentation).toBe('full');
            expect(account.artifacts.list()).toHaveLength(1);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps glass preset writes under Off, Ask and Allowed and preserves the surface choice', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ glassBlurEnabled: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        try {
            const probe = await renderHook(useGlassAppearance);
            await act(async () => { probe.getCurrent().selectPreset('clear'); });
            expect(account.persistedSettings.glassBlurEnabled).toBe(false);
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await act(async () => { probe.getCurrent().selectPreset('clear'); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.persistedSettings.glassBlurEnabled).toBe(false);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ glassBlurEnabled: true, glassBlurIntensity: 'strong' }));
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { probe.getCurrent().setSurfaceMode('card', 'glass'); });
            await vi.waitFor(() => expect(probe.getCurrent().materials.card.blur).toBe('strong'));
            await act(async () => { probe.getCurrent().setTint(60); });
            await vi.waitFor(() => expect(probe.getCurrent().tint).toBe(60));
            expect(account.artifacts.list()).toHaveLength(1);
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('admits command reset under Off, Ask and Allowed without resetting its neighbor', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ commandPaletteEnabled: false,
            keyboardShortcutsV2Enabled: true, keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
            keyboardShortcutOverridesV1: { 'commandPalette.open': [{ binding: 'Mod+K' }], 'session.new': [{ binding: 'Alt+N' }] },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        try {
            const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);
            await screen.pressByTestIdAsync('settings-keyboard-shortcut-row-commandPalette.open');
            await screen.pressByTestIdAsync('settings-keyboard-shortcut-reset-commandPalette.open');
            expect(account.persistedSettings.commandPaletteEnabled).toBe(false);
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
            })); });
            await screen.pressByTestIdAsync('settings-keyboard-shortcut-reset-commandPalette.open');
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.persistedSettings.commandPaletteEnabled).toBe(false);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ commandPaletteEnabled: true,
                keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: { 'session.new': [{ binding: 'Alt+N' }] },
            }));
            expect(account.persistedSettings.keyboardShortcutOverridesV1['commandPalette.open']).toBeUndefined();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { screen.findAll(node => node.props.testID === 'settings-keyboard-shortcut-enabled-commandPalette.open'
                && typeof node.props.onValueChange === 'function')[0]!.props.onValueChange(false); });
            await vi.waitFor(() => expect(account.persistedSettings.commandPaletteEnabled).toBe(false));
            expect(account.persistedSettings.keyboardShortcutOverridesV1['session.new']).toEqual([{ binding: 'Alt+N' }]);
            expect(account.artifacts.list()).toHaveLength(1);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
