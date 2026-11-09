import * as React from 'react';
import { act } from 'react-test-renderer';
import { Animated } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { standardCleanup } from '@/dev/testkit';
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
vi.doUnmock('@/sync/domains/state/storage');
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('SessionRuntimeSettingsView', () => {
    beforeEach(async () => {
        await account.restore({ waivedActions: ['settings.set'], settings: {
            sessionUseTmux: false, sessionTerminalHost: 'herdr', sessionTmuxSessionName: 'work',
            sessionTmuxIsolated: true, sessionTmuxTmpDir: '/tmp/work-tmux',
        } });
    });

    afterEach(async () => {
        vi.useRealTimers();
        paramsState.value = {};
        await act(async () => { setReducedMotionPreferenceOverride(null); });
        standardCleanup();
        await account.reset();
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
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        const screen = await renderSettingsView(React.createElement(SessionRuntimeSettingsView));
        expect(screen.findByTestId('settings-session-tmux-name')).toBeNull();
        await act(async () => { screen.findByTestId('settings-session-terminal-host:tmux')!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('settings-session-tmux-name')?.props.value).toBe('work'));
        expect(screen.findByTestId('settings-session-tmux-name')?.props.value).toBe('work');
        expect(screen.findByTestId('settings-session-tmux-isolated')?.props.value).toBe(true);
        expect(screen.findByTestId('settings-session-tmux-tmpdir')?.props.value).toBe('/tmp/work-tmux');
        await act(async () => {
            screen.findByTestId('settings-session-tmux-name')!.props.onChangeText('renamed');
            screen.findByTestId('settings-session-tmux-tmpdir')!.props.onChangeText('/tmp/renamed');
        });
        await act(async () => {
            screen.findByTestId('settings-session-tmux-name')!.props.onBlur();
            screen.findByTestId('settings-session-tmux-tmpdir')!.props.onSubmitEditing();
        });
        await vi.waitFor(() => expect(storage.getState().settings).toMatchObject({
            sessionTmuxSessionName: 'renamed', sessionTmuxTmpDir: '/tmp/renamed',
        }));
        await act(async () => { screen.findByTestId('settings-session-tmux-isolated')!.props.onValueChange(false); });
        await vi.waitFor(() => expect(storage.getState().settings.sessionTmuxIsolated).toBe(false));
        await vi.waitFor(() => expect(screen.findByTestId('settings-session-tmux-tmpdir')).toBeNull());
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, sessionTerminalHost: 'herdr', sessionUseTmux: false } });
        });
        expect(screen.findByTestId('settings-session-tmux-name')).toBeNull();
        expect(storage.getState().settings.sessionTmuxSessionName).toBe('renamed');
        await screen.unmount();
    });
    it.each(['settings-session-tmux-name', 'settings-session-tmux-tmpdir'])('commits ten text changes once through the real Action/store: %s', async testID => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        const screen = await renderSettingsView(<SessionRuntimeSettingsView />);
        await act(async () => { screen.findByTestId('settings-session-terminal-host:tmux')!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId(testID)).not.toBeNull());
        const key = testID.endsWith('name') ? 'sessionTmuxSessionName' : 'sessionTmuxTmpDir';
        const saved: unknown[] = [];
        const stop = storage.subscribe((next, previous) => {
            if (next.settings[key] !== previous.settings[key]) saved.push(next.settings[key]);
        });
        try {
            await act(async () => { screen.findByTestId(testID)!.props.onBlur?.(); });
            expect(saved).toEqual([]);
            for (let length = 1; length <= 10; length++) {
                await act(async () => { screen.findByTestId(testID)!.props.onChangeText('abcdefghij'.slice(0, length)); });
            }
            expect(saved).toEqual([]);
            expect(screen.findByTestId(testID)!.props.value).toBe('abcdefghij');
            await act(async () => {
                const input = screen.findByTestId(testID)!;
                input.props.onSubmitEditing();
                input.props.onBlur();
            });
            await vi.waitFor(() => expect(storage.getState().settings[key]).toBe('abcdefghij'));
            expect(saved).toEqual(['abcdefghij']);
        } finally { stop(); }
    });

    it('keeps a dirty draft on remote change and Escape restores the latest saved value without writing', async () => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        const screen = await renderSettingsView(<SessionRuntimeSettingsView />);
        await act(async () => { screen.findByTestId('settings-session-terminal-host:tmux')!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('settings-session-tmux-name')).not.toBeNull());
        const input = () => screen.findByTestId('settings-session-tmux-name')!;
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, sessionTmuxSessionName: 'remote-clean' } }); });
        expect(input().props.value).toBe('remote-clean');
        await act(async () => { input().props.onChangeText('my-draft'); });
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, sessionTmuxSessionName: 'remote-dirty' } }); });
        expect(input().props.value).toBe('my-draft');
        await act(async () => { input().props.onKeyPress({ nativeEvent: { key: 'Escape' } }); input().props.onBlur(); });
        expect(input().props.value).toBe('remote-dirty');
        expect(storage.getState().settings.sessionTmuxSessionName).toBe('remote-dirty');
    });
    it('retires an unsaved draft when the real Account owner changes', async () => {
        const { SessionRuntimeSettingsView } = await import('./SessionRuntimeSettingsView');
        const screen = await renderSettingsView(<SessionRuntimeSettingsView />);
        await act(async () => { screen.findByTestId('settings-session-terminal-host:tmux')!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('settings-session-tmux-name')).not.toBeNull());
        await act(async () => { screen.findByTestId('settings-session-tmux-name')!.props.onChangeText('private-draft'); });
        await act(async () => { await account.restore({ accountId: 'another-owner', waivedActions: ['settings.set'], settings: {
            sessionTerminalHost: 'tmux', sessionUseTmux: true, sessionTmuxSessionName: 'other-account',
        } }); });
        await vi.waitFor(() => expect(screen.findByTestId('settings-session-tmux-name')?.props.value).toBe('other-account'));
        await act(async () => { screen.findByTestId('settings-session-tmux-name')!.props.onBlur(); });
        expect(storage.getState().settings.sessionTmuxSessionName).toBe('other-account');
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
