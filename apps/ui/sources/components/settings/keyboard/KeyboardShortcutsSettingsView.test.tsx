import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';

const applySettingsSpy = vi.fn();
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
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => `${key}${params ? `:${JSON.stringify(params)}` : ''}` });
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSettings: () => settingsFixture,
    });
});
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsSpy,
}));
vi.mock('@/components/ui/lists/ItemList', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['ItemList']);
});
vi.mock('@/components/ui/lists/ItemGroup', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['ItemGroup']);
});
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props, props.rightElement as React.ReactNode),
}));
vi.mock('@/components/ui/forms/Switch', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['Switch']);
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

describe('KeyboardShortcutsSettingsView', () => {
    beforeEach(() => {
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
        capturedShortcutModalProps = null;
        modalShowSpy.mockImplementation((config) => {
            capturedShortcutModalProps = config.props as typeof capturedShortcutModalProps;
            return 'shortcut-capture-modal';
        });
    });

    afterEach(() => {
        standardCleanup();
        applySettingsSpy.mockClear();
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
        expect(screen.findByTestId('settings-keyboard-shortcut-row-commandPalette.open')?.props.title)
            .toBe('settingsKeyboard.commands.commandPaletteOpen');
        expect(screen.findByTestId('settings-keyboard-shortcut-reset-commandPalette.open')).toBeTruthy();
        expect(screen.findByTestId('settings-keyboard-shortcuts-conflicts')).toBeTruthy();
    });

    it('updates account settings for switches, per-command disable, and reset', async () => {
        settingsFixture = {
            ...settingsFixture,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
        };
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        const enabledSwitch = screen.findByTestId('settings-keyboard-shortcuts-enabled');
        enabledSwitch?.props.onValueChange(true);
        expect(applySettingsSpy).toHaveBeenCalledWith({ keyboardShortcutsV2Enabled: true });

        const disabledCommandSwitch = screen.findByTestId('settings-keyboard-shortcut-enabled-commandPalette.open');
        disabledCommandSwitch?.props.onValueChange(true);
        expect(applySettingsSpy).toHaveBeenCalledWith({
            keyboardShortcutDisabledCommandIdsV1: [],
            commandPaletteEnabled: true,
        });

        screen.pressByTestId('settings-keyboard-shortcut-reset-commandPalette.open');
        expect(applySettingsSpy).toHaveBeenCalledWith({
            keyboardShortcutDisabledCommandIdsV1: [],
            commandPaletteEnabled: true,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+K' }],
            },
        });
    });

    it('opens a shortcut capture modal and stores the resolved binding as a command override', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-set-commandPalette.open');

        expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({
            component: expect.any(Function),
            props: expect.objectContaining({ defaultValue: 'Mod+K' }),
        }));
        expect(capturedShortcutModalProps).toEqual(expect.objectContaining({ defaultValue: 'Mod+K' }));

        await act(async () => {
            capturedShortcutModalProps?.onResolve(' Alt+S ');
        });

        expect(applySettingsSpy).toHaveBeenCalledWith({
            keyboardShortcutDisabledCommandIdsV1: [],
            commandPaletteEnabled: true,
            keyboardShortcutOverridesV1: {
                'commandPalette.open': [{ binding: 'Alt+S' }],
                'session.new': [{ binding: 'Mod+K' }],
            },
        });
    });

    it('shows an alert and leaves settings untouched when a custom shortcut is invalid', async () => {
        const { KeyboardShortcutsSettingsView } = await import('./KeyboardShortcutsSettingsView');
        const screen = await renderSettingsView(<KeyboardShortcutsSettingsView />);

        await screen.pressByTestIdAsync('settings-keyboard-shortcut-set-commandPalette.open');

        await act(async () => {
            capturedShortcutModalProps?.onResolve('Shift+');
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'settingsKeyboard.setShortcutInvalidTitle',
            'settingsKeyboard.setShortcutInvalidMessage',
        );
        expect(applySettingsSpy).not.toHaveBeenCalled();
    });
});
