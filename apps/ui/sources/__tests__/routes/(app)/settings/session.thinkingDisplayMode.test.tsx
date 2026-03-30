import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    setThinkingDisplayMode: vi.fn(),
    setThinkingInlinePresentation: vi.fn(),
}));

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TextInput: 'TextInput',
        });
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: (key: string) => {
                    if (key === 'sessionThinkingDisplayMode') return ['inline', shared.setThinkingDisplayMode];
                    if (key === 'sessionThinkingInlinePresentation') return ['summary', shared.setThinkingInlinePresentation];
                    return [null, vi.fn()];
                },
            },
        });
    },
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
    shared.setThinkingDisplayMode.mockClear();
    shared.setThinkingInlinePresentation.mockClear();
});

describe('Transcript settings (thinking display mode)', () => {
    it('renders a dropdown and updates session thinking mode + inline presentation', async () => {
        const mod = await import('@/app/(app)/settings/session/transcript');
        const screen = await renderSettingsView(React.createElement(mod.default));

        expect(screen.findRowByTitle('settingsSession.thinking.displayModeTitle')).toBeTruthy();

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        expect(dropdowns.length).toBeGreaterThan(0);

        const thinkingDropdown = dropdowns.find((dropdown: any) => dropdown?.props?.selectedId === 'inline_summary');
        expect(thinkingDropdown).toBeTruthy();

        await act(async () => {
            thinkingDropdown!.props.onSelect('inline_full');
        });

        expect(shared.setThinkingDisplayMode).toHaveBeenCalledWith('inline');
        expect(shared.setThinkingInlinePresentation).toHaveBeenCalledWith('full');
    });
});
