import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
afterEach(standardCleanup);
const { ThemeLibraryView } = await import('./ThemeLibraryView');
function document(id: string, name: string) {
    const parsed = parseThemeProfileDocument(createThemeProfileDraft({ id, name, now: '2026-11-16T12:00:00.000Z' }));
    if (!parsed.ok) throw new Error('Invalid fixture');
    return parsed.document;
}
const firstId = '11111111-1111-4111-8111-111111111111';
it('windows a 200-theme library through the shared Collection', async () => {
    const miniature = projectThemeLibraryEntry(document(firstId, 'Preview')).miniature;
    const preview = { kind: 'miniature' as const, miniature };
    const screen = await renderSettingsView(<ThemeLibraryView mode="light" selectedKey="theme-0"
        slots={{ light: { mode: 'light', name: 'Light', sourceLabel: 'Built-in', preview, showing: true },
            dark: { mode: 'dark', name: 'Dark', sourceLabel: 'Built-in', preview, showing: false } }}
        tiles={Array.from({ length: 200 }, (_, index) => ({ key: `theme-${index}`, name: `Theme ${index}`,
            sourceLabel: 'Made by you', preview, menu: [] }))}
        hasOwnThemes addMenu={[]} onNewTheme={() => {}} onChooseMode={() => {}} onChooseTheme={() => {}} />);
    await act(async () => {
        for (const node of screen.tree.root.findAll(node => typeof node.type === 'string'
            && (node.props.testID === 'settings-theme-profiles-screen' || node.props.testID === 'settings-theme-light-library' || node.props.testID === 'settings-theme-light-library:stage')
            && typeof node.props.onLayout === 'function')) {
            node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 960, height: 600 } } });
        }
    });
    await measureMountedCollections(screen, { width: 960, height: 600 });
    const tiles = screen.tree.root.findAll(node => typeof node.props.testID === 'string'
        && /^settings-theme-light:theme-\d+:card$/.test(node.props.testID) && typeof node.type === 'string');
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(200);
});

it('shows omitted theme parts and phone CSS coverage beside the update repair', async () => {
    const miniature = projectThemeLibraryEntry(document(firstId, 'Preview')).miniature;
    const preview = { kind: 'miniature' as const, miniature };
    const update = vi.fn();
    const screen = await renderSettingsView(<ThemeLibraryView mode="light" selectedKey="light"
        slots={{ light: { mode: 'light', name: 'Light', sourceLabel: 'Built-in', preview, showing: true },
            dark: { mode: 'dark', name: 'Dark', sourceLabel: 'Built-in', preview, showing: false } }}
        tiles={[]} hasOwnThemes addMenu={[]} onNewTheme={() => {}} onChooseMode={() => {}} onChooseTheme={() => {}}
        facts={[{ kind: 'partial', name: 'Future', unsupportedPaths: ['style.futurePresentation'], webOnlyRules: 2, onUpdate: update }]} />);
    const notice = screen.findByTestId('settings-theme-notice');
    expect(notice).not.toBeNull();
    const text = notice!.findAll(node => typeof node.type === 'string').flatMap(node => node.children).join(' ');
    expect(text).toContain('style.futurePresentation');
    expect(text).toContain('count=2');
    const repair = notice!.findAll(node => typeof node.props.onPress === 'function')[0];
    expect(repair).toBeDefined();
    await act(async () => { repair!.props.onPress(); });
    expect(update).toHaveBeenCalledOnce();
});
