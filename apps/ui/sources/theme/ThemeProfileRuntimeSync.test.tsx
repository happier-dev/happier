import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { darkTheme, lightTheme, type Theme } from '@/theme';

const shared = vi.hoisted(() => ({
    themes: null as Record<'light' | 'dark', Theme> | null,
    update: vi.fn((name: 'light' | 'dark', updater: (theme: Theme) => Theme) => {
        if (shared.themes) shared.themes[name] = updater(shared.themes[name]);
    }),
}));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Appearance: { getColorScheme: () => 'light' },
    }));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ runtime: {
        getTheme: (name: 'light' | 'dark') => shared.themes?.[name], updateTheme: shared.update,
    } }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const { ThemeProfileRuntimeSync } = await import('./ThemeProfileRuntimeSync');

async function setup() {
    const fixture = await createPlainArtifactHomeFixture('https://theme-runtime-sync.test', { currentAccount: true });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
    const row = (id: string, canvas: string, version = 1): DecryptedArtifact => ({
        id, sourceServerId: scope.serverId, ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true,
        title: id, headerVersion: version, bodyVersion: version, seq: version, createdAt: 0, updatedAt: version,
        rawHeader: { v: 1, kind: 'theme_profile.v1', title: id, mode: 'light', themeSource: { kind: 'yours' },
            compatibility: { status: 'supported', unsupportedPaths: [] },
            palette: { overrides: { 'background.canvas': canvas }, radius: 'round' } },
        body: JSON.stringify({ schemaVersion: 1, id, name: id, createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: { 'background.canvas': canvas }, dark: {} },
            assetAppearance: 'light', style: { radius: 'round' } }),
    });
    shared.themes = { light: lightTheme, dark: darkTheme };
    shared.update.mockClear();
    storage.getState().applyLocalSettings({ ...localSettingsDefaults, themePreference: 'light',
        themeProfileSelection: { light: { kind: 'artifact', id: 'selected' }, dark: null } });
    storage.getState().applyArtifacts([row('selected', '#f1e2d3')]);
    return { ...fixture, scope, row };
}

describe('Artifact-backed theme runtime synchronization', () => {
    it('renders the shared preview and restores the latest saved selection when its receipt is released', async () => {
        const fixture = await setup();
        const { getThemeTryOnOwner } = await import('./profiles/themeTryOnRuntime');
        const { parseThemeProfileDocument } = await import('@happier-dev/protocol/account/settings/themeProfiles');
        const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'preview', name: 'Preview',
            createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' },
            overrides: { light: { 'background.canvas': '#123456' }, dark: {} } });
        if (!parsed.ok) throw new Error('Invalid preview fixture');
        const screen = await renderScreen(<ThemeProfileRuntimeSync />);
        const owner = getThemeTryOnOwner();
        let receipt!: ReturnType<typeof owner.begin>;
        shared.update.mockClear();
        await act(async () => { receipt = owner.begin({ document: parsed.document, mode: 'light', origin: { kind: 'editor' } }); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#123456');
        expect(shared.update).toHaveBeenCalledTimes(1);
        expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual({ kind: 'artifact', id: 'selected' });
        shared.update.mockClear();
        await act(async () => { storage.getState().updateArtifact(fixture.row('selected', '#ddeeff', 2)); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#123456');
        expect(shared.update).not.toHaveBeenCalled();
        await act(async () => { owner.revert(receipt.previewRef); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#ddeeff');
        expect(shared.update).toHaveBeenCalledTimes(1);
        await act(async () => { receipt = owner.begin({ document: parsed.document, mode: 'light', origin: { kind: 'editor' } }); });
        await act(async () => { storage.setState({ settingsScope: { ...fixture.scope, accountId: 'another-account' } }); });
        expect(shared.themes!.light.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
        await act(async () => { owner.revert(receipt.previewRef); });
        await screen.unmount();
    });
    it('keeps host-selected embedded themes with their host runtime owner', async () => {
        await setup();
        const screen = await renderScreen(<ThemeProfileRuntimeSync enabled={false} />);
        expect(shared.update).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('publishes only selected paint changes and falls back across missing selections and Account changes', async () => {
        const fixture = await setup();
        const screen = await renderScreen(<ThemeProfileRuntimeSync />);
        expect(shared.themes!.light.colors.background.canvas).toBe('#f1e2d3');
        expect(shared.themes!.light.borderRadius.xl).toBeGreaterThan(lightTheme.borderRadius.xl);
        expect(shared.update).toHaveBeenCalledTimes(1);
        shared.update.mockClear();
        await act(async () => {
            storage.getState().updateArtifact(fixture.row('unrelated', '#123456'));
            storage.getState().applySettingsLocal({ showFlavorIcons: true });
            storage.getState().applyLocalSettings({ uiFontScale: 1.15 });
        });
        expect(shared.update).not.toHaveBeenCalled();
        await act(async () => { storage.getState().updateArtifact(fixture.row('selected', '#ddeeff', 2)); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#ddeeff');
        expect(shared.update).toHaveBeenCalledTimes(1);
        shared.update.mockClear();
        await act(async () => { storage.getState().applyLocalSettings({ uiSurfaceFinish: 'flat',
            uiSurfaceFinishOverrides: { composer: 'soft' } }); });
        expect(shared.themes!.light.parts.card.finish).toBe('flat');
        expect(shared.themes!.light.parts.composer.finish).toBe('soft');
        expect(shared.themes!.light.borderRadius.xl).toBeGreaterThan(lightTheme.borderRadius.xl);
        expect(shared.update).toHaveBeenCalledTimes(1);
        await act(async () => { storage.getState().applyLocalSettings({ themeProfileSelection: {
            light: { kind: 'artifact', id: 'missing' }, dark: null } }); });
        expect(shared.themes!.light.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
        await act(async () => { storage.getState().applyLocalSettings({ themeProfileSelection: {
            light: { kind: 'artifact', id: 'selected' }, dark: null } }); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#ddeeff');
        await act(async () => { storage.setState({ settingsScope: { ...fixture.scope, accountId: 'another-account' } }); });
        expect(shared.themes!.light.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
        expect(fixture.requests.filter(request => request.method === 'POST' && request.path.startsWith('/v1/artifacts'))).toEqual([]);
        await screen.unmount();
    });
});
