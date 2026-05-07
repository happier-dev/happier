import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

installSessionSettingsEntryModuleMocks({
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return {
            ...createTextModuleMock(),
            getLanguageNativeName: () => 'English',
            SUPPORTED_LANGUAGES: { en: { name: 'English' } },
        };
    },
});

beforeEach(() => {
    sessionSettingsEntryState.settingsState = {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
        avatarStyle: 'meshGradientColumns',
        showFlavorIcons: true,
        preferredLanguage: null,
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        detailsPaneTabsBehavior: 'preview',
    };
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Appearance settings avatar style', () => {
    it('renders avatar style selection as a dropdown with preview icons', async () => {
        const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen), {
            flushOptions: { cycles: 0 },
        });

        const avatarStyleDropdown = screen.findByProps({ selectedId: 'meshGradientColumns' });

        await act(async () => {
            avatarStyleDropdown.props.onSelect('meshGradientRows');
        });

        expect(sessionSettingsEntryState.settingsState.avatarStyle).toBe('meshGradientRows');
        const items = avatarStyleDropdown.props.items as ReadonlyArray<Readonly<{ id: string; icon?: React.ReactNode }>>;
        expect(items.some((item) => item.id === 'meshGradientRows' && item.icon)).toBe(true);
        expect(items.some((item) => item.id === 'meshGradientColumns' && item.icon)).toBe(true);
        expect(items.some((item) => item.id === 'meshGradientDiagonal' && item.icon)).toBe(true);
        expect(items.some((item) => item.id === 'photoGradientRows' && item.icon)).toBe(true);
        expect(items.some((item) => item.id === 'photoGradientDiagonal' && item.icon)).toBe(true);
        expect(items.some((item) => item.id === 'photoGradientMeshGrid' && item.icon)).toBe(true);
    });
});
