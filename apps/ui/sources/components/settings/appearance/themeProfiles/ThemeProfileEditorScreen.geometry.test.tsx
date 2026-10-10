// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

const route = vi.hoisted(() => ({ profileId: 'new' }));
installSettingsViewCommonModuleMocks({
    reactNative: async () => vi.importActual('react-native-web'),
    storage: 'real',
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => route }).module,
    text: async () => vi.importActual('@/text'),
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native');
    const mock = createReanimatedModuleMock();
    const Animated = { ...mock.default, View: native.View, ScrollView: native.ScrollView, Text: native.Text };
    return { ...mock, ...Animated, default: Animated };
});
// The native gesture canvas is a third-party boundary; it is closed during
// this editor/focus layout check. Keep the real input, swatch and popover owner.
vi.mock('reanimated-color-picker', async () => (await import('@/dev/testkit/mocks/reanimatedColorPicker')).createReanimatedColorPickerMock());

const { getStorage } = await import('@/sync/domains/state/storage');
const { ThemeProfileEditorScreen } = await import('./ThemeProfileEditorScreen');
const { createThemeProfileDraft, updateThemeProfileDraftColor } = await import('@/theme/profiles/createThemeProfileDraft');
const { THEME_PROFILE_TOKEN_DEFINITIONS } = await import('@/theme/profiles/themeProfileTokenRegistry');

it('fits the entire new theme draft at 390px before and after initial Name focus', async () => {
    installWebLayoutBridge();
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 390 }, innerHeight: { configurable: true, value: 844 } });
    window.dispatchEvent(new Event('resize'));
    const store = getStorage();
    const localSettings = store.getState().localSettings;
    store.setState({ localSettings: { ...localSettings, themePreference: 'light' } });
    const host = document.createElement('div');
    host.style.height = '844px';
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<ThemeProfileEditorScreen />));
        for (const focusedTestId of [undefined, 'settings-theme-profile-name']) {
            const measured = await measureWebLayout(host, { viewport: { width: 390, height: 844 },
                focusedTestId, settle: replay => act(replay) });
            const scroll = measured.rect('settings-theme-profile-editor');
            expect(scroll.scrollWidth, 'the scroll owner has no horizontal excess').toBeLessThanOrEqual(scroll.clientWidth! + 1);
            expect(scroll.scrollLeft, 'focus cannot shift the content sideways').toBe(0);
            for (const [id, boxes] of measured.rects) {
                for (const box of boxes) {
                    expect(box.left, id).toBeGreaterThanOrEqual(0);
                    expect(box.right, id).toBeLessThanOrEqual(391);
                }
            }
        }
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
        await act(async () => window.dispatchEvent(new Event('resize')));
        const desktop = await measureWebLayout(host, { viewport: { width: 1440, height: 900 }, settle: replay => act(replay) });
        for (const [id, boxes] of desktop.rects) {
            if (id.startsWith('settings-theme-color-input-')) {
                expect(boxes[0]!.width, `desktop ${id} remains usable`).toBeGreaterThan(0);
            }
        }
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
        await act(async () => window.dispatchEvent(new Event('resize')));
        // An edited token adds Reset alongside the swatch/input. That neighboring
        // layout must stay bounded too, including focus on a longer rgba value.
        const token = THEME_PROFILE_TOKEN_DEFINITIONS[0]!;
        const now = '2026-10-10T00:00:00.000Z';
        const draft = updateThemeProfileDraftColor(createThemeProfileDraft({ id: 'edited', name: 'Edited theme', now }),
            'light', token.id, 'rgba(255, 128, 64, 0.75)', now);
        route.profileId = draft.id;
        await act(async () => {
            store.setState({ localSettings: { ...localSettings, themePreference: 'light', themeProfiles: {
                activeProfileIds: { light: null, dark: null }, profiles: [draft],
            } } });
            root.render(<ThemeProfileEditorScreen key={draft.id} />);
        });
        expect(host.querySelector(`[data-testid="settings-theme-color-reset-light-${token.id}"]`)).not.toBeNull();
        const edited = await measureWebLayout(host, { viewport: { width: 390, height: 844 },
            focusedTestId: `settings-theme-color-input-light-${token.id}`, settle: replay => act(replay) });
        const scroll = edited.rect('settings-theme-profile-editor');
        expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth! + 1);
        expect(scroll.scrollLeft).toBe(0);
        const input = edited.rect(`settings-theme-color-input-light-${token.id}`);
        expect(input.width).toBeGreaterThan(0);
        expect(input.right).toBeLessThanOrEqual(390);
    } finally {
        await act(async () => root.unmount());
        store.setState({ localSettings });
        host.remove();
        route.profileId = 'new';
    }
});
