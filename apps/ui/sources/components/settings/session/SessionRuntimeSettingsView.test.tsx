import * as React from 'react';
import { act } from 'react-test-renderer';
import { Animated } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';
import { SESSION_RUNTIME_SETTINGS } from './sessionRuntimeSettings';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

const paramsState = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => paramsState.value }).module;
});

installSessionSettingsCommonModuleMocks({
    storage: async (importOriginal) => {
        return importOriginal();
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('SessionRuntimeSettingsView', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        storage.setState({ settings: { ...settingsDefaults, sessionUseTmux: false, sessionTerminalHost: 'herdr' },
            settingsScope: { serverId: 'server-a', accountId: 'account-a' }, settingsVersion: 1 });
    });

    afterEach(async () => {
        vi.useRealTimers();
        paramsState.value = {};
        await act(async () => { setReducedMotionPreferenceOverride(null); });
        vi.restoreAllMocks();
    });

    it.each([false, true])('reveals the terminal section for a hidden tmux result (reduced motion: %s)', async (reducedMotion) => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        paramsState.value = { setting: SESSION_RUNTIME_SETTINGS.settings.sessionName.anchor };
        setReducedMotionPreferenceOverride(reducedMotion);
        vi.useFakeTimers();
        const pulse = vi.spyOn(Animated, 'sequence');
        const screen = await renderSettingsView(React.createElement(SessionRuntimeSettingsView));
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

        expect(screen.findByTestId('settings-session-tmux-name')).toBeNull();
        expect(screen.findByTestId(`setting-reveal.${SESSION_RUNTIME_SETTINGS.sectionRefs.terminal.id}`)).not.toBeNull();
        expect(screen.findByTestId(`setting-reveal.${SESSION_RUNTIME_SETTINGS.settings.sessionName.anchor}`)).toBeNull();
        expect(screen.findByTestId('settings-session-terminal-host:herdr')?.props.accessibilityState.checked).toBe(true);
        if (reducedMotion) expect(pulse).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('reveals the matching row when tmux is selected and the section when isolation hides its directory', async () => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        paramsState.value = { setting: SESSION_RUNTIME_SETTINGS.settings.tmpDir.anchor };
        storage.setState({ settings: { ...settingsDefaults, sessionUseTmux: true, sessionTerminalHost: 'tmux', sessionTmuxIsolated: true } });
        vi.useFakeTimers();
        const render = () => React.createElement(SessionRuntimeSettingsView);
        const screen = await renderSettingsView(render());
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.findByTestId(`setting-reveal.${SESSION_RUNTIME_SETTINGS.settings.tmpDir.anchor}`)).not.toBeNull();
        expect(screen.findByTestId(`setting-reveal.${SESSION_RUNTIME_SETTINGS.sectionRefs.terminal.id}`)).toBeNull();
        await screen.unmount();

        storage.setState({ settings: { ...storage.getState().settings, sessionTmuxIsolated: false } });
        const hidden = await renderSettingsView(render());
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(hidden.findByTestId('settings-session-tmux-tmpdir')).toBeNull();
        expect(hidden.findByTestId(`setting-reveal.${SESSION_RUNTIME_SETTINGS.sectionRefs.terminal.id}`)).not.toBeNull();
        await hidden.unmount();
    });

    it('transfers a retained search reveal between the section and its row as the host changes', async () => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        paramsState.value = { setting: SESSION_RUNTIME_SETTINGS.settings.sessionName.anchor };
        vi.useFakeTimers();
        const screen = await renderSettingsView(React.createElement(SessionRuntimeSettingsView));
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        const sectionMarker = `setting-reveal.${SESSION_RUNTIME_SETTINGS.sectionRefs.terminal.id}`;
        const rowMarker = `setting-reveal.${SESSION_RUNTIME_SETTINGS.settings.sessionName.anchor}`;
        expect(screen.findByTestId(sectionMarker)).not.toBeNull();

        await act(async () => { screen.findByTestId('settings-session-terminal-host:tmux')!.props.onPress(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.findByTestId(rowMarker)).not.toBeNull();
        expect(screen.findByTestId(sectionMarker)).toBeNull();

        await act(async () => { screen.findByTestId('settings-session-terminal-host:none')!.props.onPress(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.findByTestId(rowMarker)).toBeNull();
        expect(screen.findByTestId(sectionMarker)).not.toBeNull();
        await screen.unmount();
    });

    it('shows the existing account tmux settings only for tmux, retaining the saved values', async () => {
        storage.setState({ settings: { ...settingsDefaults, sessionUseTmux: true, sessionTerminalHost: 'tmux',
            sessionTmuxSessionName: 'work', sessionTmuxIsolated: true, sessionTmuxTmpDir: '/tmp/work-tmux' } });
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionRuntimeSettingsView));
        expect(screen.findByTestId('settings-session-tmux-name')?.props.value).toBe('work');
        expect(screen.findByTestId('settings-session-tmux-isolated')?.props.value).toBe(true);
        expect(screen.findByTestId('settings-session-tmux-tmpdir')?.props.value).toBe('/tmp/work-tmux');
        await act(async () => {
            screen.findByTestId('settings-session-tmux-name')!.props.onChangeText('renamed');
            screen.findByTestId('settings-session-tmux-tmpdir')!.props.onChangeText('/tmp/renamed');
        });
        expect(storage.getState().settings.sessionTmuxSessionName).toBe('renamed');
        expect(storage.getState().settings.sessionTmuxTmpDir).toBe('/tmp/renamed');
        await act(async () => { screen.findByTestId('settings-session-tmux-isolated')!.props.onValueChange(false); });
        expect(storage.getState().settings.sessionTmuxIsolated).toBe(false);
        expect(screen.findByTestId('settings-session-tmux-tmpdir')).toBeNull();
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionTerminalHost: 'herdr', sessionUseTmux: false } });
        });
        expect(screen.findByTestId('settings-session-tmux-name')).toBeNull();
        expect(storage.getState().settings.sessionTmuxSessionName).toBe('renamed');
        await screen.unmount();
    });
    it('keeps the runtime control without offering obsolete legacy-secret issuance', async () => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionRuntimeSettingsView));

        const row = screen.findRowByTitle('settingsSessionPages.runtime.terminalHostTitle');
        expect(row).toBeTruthy();
        expect(screen.findByTestId('settings-session-terminal-host:herdr')?.props.accessibilityState.checked).toBe(true);
        expect(screen.findRowByTitle('settingsSession.terminalConnect.legacySecretExportTitle')).toBeNull();
    });
});
