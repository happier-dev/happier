import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';

const routerSetParamsSpy = vi.fn();
const modalShowSpy = vi.fn();
const modalAlertSpy = vi.fn();
let settingsFixture: typeof settingsDefaults;
let capturedShortcutModalProps: {
    defaultValue?: string;
    onResolve: (value: string | null) => void;
} | null = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { setParams: routerSetParamsSpy } }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => `${key}${params ? `:${JSON.stringify(params)}` : ''}` });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalShowSpy,
            alertAsync: modalAlertSpy,
        },
    }).module;
});

const account = createProviderSettingsAccountHarness();
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const { Switch } = await import('@/components/ui/forms/Switch');

// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./KeyboardShortcutsSettingsView');

describe('KeyboardShortcutsSettingsView', () => {
    beforeEach(async () => {
        settingsFixture = {
            ...settingsDefaults,
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: false,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutDisabledCommandIdsV1: [],
            keyboardShortcutOverridesV1: {
                'commandPalette.open': [{ binding: 'Mod+K' }],
                'session.new': [{ binding: 'Mod+K' }],
            },
        };
        await account.restore({ settings: settingsFixture });
        capturedShortcutModalProps = null;
        modalShowSpy.mockImplementation((config) => {
            capturedShortcutModalProps = config.props as typeof capturedShortcutModalProps;
            return 'shortcut-capture-modal';
        });
    });

    afterEach(async () => {
        standardCleanup();
        await account.reset();
        routerSetParamsSpy.mockClear();
        modalShowSpy.mockReset();
        modalAlertSpy.mockReset();
        capturedShortcutModalProps = null;
    });

    it('renders shortcut toggles, explicit command rows, and conflict diagnostics', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        expect(screen.findByTestId('settings-keyboard-shortcuts-screen')).toBeTruthy();
        expect(screen.findByTestId('settings-keyboard-shortcuts-enabled')).toBeTruthy();
        expect(screen.findByTestId('settings-keyboard-shortcuts-single-key-enabled')).toBeTruthy();
        expect(screen.findByTestId('settings-keyboard-shortcut-row-commandPalette.open')).toBeTruthy();
        expect(screen.findByTestId('settings-keyboard-shortcut-row-workspace.tab.closeAll')).toBeTruthy();
        expect(screen.findAll(node => node.props.testID === 'settings-keyboard-shortcut-row-commandPalette.open' && node.props.title)[0]?.props.title)
            .toBe('settingsKeyboard.commands.commandPaletteOpen');
        // Closed, a command shows its keys; its controls live inside the expanded row.
        expect(screen.findByTestId('settings-keyboard-shortcut-reset-commandPalette.open')).toBeFalsy();
        await screen.pressByTestIdAsync('settings-keyboard-shortcut-row-commandPalette.open');
        expect(screen.findByTestId('settings-keyboard-shortcut-reset-commandPalette.open')).toBeTruthy();
        // The duplicate Mod+K binding names both commands in one conflict row.
        const conflict = screen.findAll(node => node.props.testID === 'settings-keyboard-shortcuts-conflict-duplicate:commandPalette.open:session.new' && node.props.title)[0];
        expect(conflict?.props.title).toBe('settingsKeyboard.commands.commandPaletteOpen · settingsKeyboard.commands.sessionNew');
    });

    it('opens a conflict at the command it names: the row expands and the page reveals it', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        expect(screen.findByTestId('settings-keyboard-shortcut-reset-commandPalette.open')).toBeFalsy();
        await screen.pressByTestIdAsync('settings-keyboard-shortcuts-conflict-duplicate:commandPalette.open:session.new');

        expect(screen.findByTestId('settings-keyboard-shortcut-reset-commandPalette.open')).toBeTruthy();
        // The command's own search anchor scrolls it into view and pulses it.
        expect(routerSetParamsSpy).toHaveBeenLastCalledWith({ setting: 'keyboard.commandPalette.open' });
    });

    it('lists commands under their app-area sections and offers reset only when there is something to restore', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        const sectionTitles = screen.findAllByType(ItemGroup).map((group) => group.props.title);
        expect(sectionTitles).toEqual(expect.arrayContaining([
            'settingsKeyboard.groupApp',
            'settingsKeyboard.groupSessions',
            'settingsKeyboard.groupComposer',
            'settingsKeyboard.groupTranscript',
        ]));

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-row-composer.focus');
        expect(screen.findByTestId('settings-keyboard-shortcut-set-composer.focus')).toBeTruthy();
        expect(screen.findByTestId('settings-keyboard-shortcut-reset-composer.focus')).toBeFalsy();
    });

    it('updates account settings for switches, per-command disable, and reset', async () => {
        settingsFixture = {
            ...settingsFixture,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
        };
        storage.setState({ settings: settingsFixture });
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        const enabledSwitch = screen.findAllByType(Switch).find(node => node.props.testID === 'settings-keyboard-shortcuts-enabled');
        await act(async () => { enabledSwitch?.props.onValueChange(true); });
        await vi.waitFor(() => expect(storage.getState().settings.keyboardShortcutsV2Enabled).toBe(true));

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-row-commandPalette.open');
        const disabledCommandSwitch = screen.findAllByType(Switch).find(node => node.props.testID === 'settings-keyboard-shortcut-enabled-commandPalette.open');
        await act(async () => { disabledCommandSwitch?.props.onValueChange(true); });
        await vi.waitFor(() => expect(storage.getState().settings).toMatchObject({
            keyboardShortcutDisabledCommandIdsV1: [],
            commandPaletteEnabled: true,
        }));

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-reset-commandPalette.open');
        await vi.waitFor(() => expect(storage.getState().settings).toMatchObject({
            keyboardShortcutDisabledCommandIdsV1: [],
            commandPaletteEnabled: true,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+K' }],
            },
        }));
    });

    it('opens a shortcut capture modal and stores the resolved binding as a command override', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-row-commandPalette.open');
        await screen.pressByTestIdAsync('settings-keyboard-shortcut-set-commandPalette.open');

        expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({
            component: expect.any(Function),
            props: expect.objectContaining({ defaultValue: 'Mod+K' }),
        }));
        expect(capturedShortcutModalProps).toEqual(expect.objectContaining({ defaultValue: 'Mod+K' }));

        await act(async () => {
            capturedShortcutModalProps?.onResolve(' Alt+S ');
        });

        await vi.waitFor(() => expect(storage.getState().settings).toMatchObject({
            keyboardShortcutDisabledCommandIdsV1: [],
            commandPaletteEnabled: true,
            keyboardShortcutOverridesV1: {
                'commandPalette.open': [{ binding: 'Alt+S' }],
                'session.new': [{ binding: 'Mod+K' }],
            },
        }));
    });

    it('shows an alert and leaves settings untouched when a custom shortcut is invalid', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        const unchangedSettings = storage.getState().settings;

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-row-commandPalette.open');
        await screen.pressByTestIdAsync('settings-keyboard-shortcut-set-commandPalette.open');

        await act(async () => {
            capturedShortcutModalProps?.onResolve('Shift+');
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'settingsKeyboard.setShortcutInvalidTitle',
            'settingsKeyboard.setShortcutInvalidMessage',
        );
        expect(storage.getState().settings).toBe(unchangedSettings);
    });
});
