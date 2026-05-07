import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

installSessionSettingsEntryModuleMocks();

beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/text', () => ({
        ...createTextModuleMock(),
        getLanguageNativeName: () => 'English',
        SUPPORTED_LANGUAGES: { en: { name: 'English' } },
    }));
    sessionSettingsEntryState.settingsState = {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        detailsPaneTabsBehavior: 'preview',
    };
});

afterEach(() => {
    resetSessionSettingsEntryState();
});

describe('AppearanceSettingsScreen (focused groups after redistribution)', () => {
    it('renders core appearance settings after redistribution', async () => {
        const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');
        const screen = await renderScreen(React.createElement(AppearanceSettingsScreen));

        const items = screen.findAllByType('Item' as any);
        const titles = items.map((i) => i.props.title);
        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        const dropdownTitles = dropdowns.map((node: any) => node.props?.itemTrigger?.title).filter(Boolean);

        // Core appearance settings that remain
        expect(titles).toContain('settings.appearance');
        expect(titles).toContain('settingsAppearance.avatarStyle');
        expect(titles).toContain('settingsAppearance.showFlavorIcons');
        expect(titles).toContain('settingsAppearance.multiPanePanels');
        expect(dropdownTitles).toContain('settingsAppearance.textSize');
        expect(dropdownTitles).toContain('settingsAppearance.itemDensity');

        // Session list settings moved to session.tsx — should NOT be here
        expect(titles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(titles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(titles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
    });
});
