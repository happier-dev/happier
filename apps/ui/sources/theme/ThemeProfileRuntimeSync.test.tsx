import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { registerNativeThemePreferenceTransitionController } from '@/components/settings/appearance/themePreferenceTransition';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

const shared = vi.hoisted(() => ({
    themes: null as Record<'light' | 'dark', Theme> | null,
    setTheme: vi.fn(),
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
        setTheme: shared.setTheme,
    } }));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const { ThemeProfileRuntimeSync } = await import('./ThemeProfileRuntimeSync');
const { initializeArtifactInventoryDemandHarness } = await import('@/dev/testkit/harness/artifactInventoryDemandHarness');
await initializeArtifactInventoryDemandHarness();

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
    it('reveals Apply once, keeps an already-painted preview without repainting, and preserves the mode transition', async () => {
        const { createArtifactInventoryDemandHarness } = await import('@/dev/testkit/harness/artifactInventoryDemandHarness');
        const fixture = await createArtifactInventoryDemandHarness();
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Missing admitted Account');
        shared.themes = { light: lightTheme, dark: darkTheme };
        storage.getState().applyLocalSettings({ ...localSettingsDefaults, themePreference: 'light',
            themeProfileSelection: { light: null, dark: null } });
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const { getThemeTryOnOwner } = await import('./profiles/themeTryOnRuntime');
        const { getBuiltInThemeProfileDocument } = await import('./profiles/builtInThemeProfiles');
        const { themeModeStorageBinding } = await import('@/components/settings/appearance/themeModeSettingBinding');
        const screen = await renderScreen(<ThemeProfileRuntimeSync />);
        const transition = vi.fn((mutation: () => void) => mutation());
        const unregister = registerNativeThemePreferenceTransitionController({ run: transition });
        setReducedMotionPreferenceOverride(false);
        onTestFinished(() => { unregister(); setReducedMotionPreferenceOverride(null); });
        shared.update.mockClear();
        shared.setTheme.mockClear();
        await act(async () => {
            await getSyncSingleton().withThemeProfileLibrary(library => library.select({
                mode: 'light', reference: { kind: 'built-in', presetId: 'premiumLight' },
            }), { expectedScope: scope });
        });
        expect(transition).toHaveBeenCalledTimes(1);
        expect(shared.setTheme).toHaveBeenCalledTimes(1);
        expect(shared.update).toHaveBeenCalledTimes(1);
        const document = getBuiltInThemeProfileDocument('premiumDark');
        if (!document) throw new Error('Missing built-in fixture');
        const owner = getThemeTryOnOwner();
        let receipt!: ReturnType<typeof owner.begin>;
        await act(async () => { receipt = owner.begin({ document, selection: { kind: 'built-in', presetId: 'premiumDark' },
            mode: 'dark', origin: { kind: 'editor' } }); });
        expect(transition).toHaveBeenCalledTimes(2);
        shared.setTheme.mockClear();
        shared.update.mockClear();
        await act(async () => { await owner.keep(receipt.previewRef); });
        expect(owner.read()).toBeNull();
        expect(transition).toHaveBeenCalledTimes(2);
        expect(shared.setTheme).not.toHaveBeenCalled();
        expect(shared.update).not.toHaveBeenCalled();
        await act(async () => {
            await themeModeStorageBinding.commit(storage.getState().localSettings, 'light',
                delta => storage.getState().applyLocalSettings(delta), { accountScope: scope, isCurrent: () => true });
        });
        expect(transition).toHaveBeenCalledTimes(3);
        expect(shared.setTheme).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
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
        const transition = vi.fn((mutation: () => void) => mutation());
        const unregister = registerNativeThemePreferenceTransitionController({ run: transition });
        setReducedMotionPreferenceOverride(false);
        onTestFinished(() => { unregister(); setReducedMotionPreferenceOverride(null); });
        let receipt!: ReturnType<typeof owner.begin>;
        shared.update.mockClear();
        shared.setTheme.mockClear();
        await act(async () => { receipt = owner.begin({ document: parsed.document, mode: 'light', origin: { kind: 'editor' } }); });
        expect(transition).toHaveBeenCalledTimes(1);
        expect(shared.setTheme).toHaveBeenCalledTimes(1);
        expect(shared.themes!.light.colors.background.canvas).toBe('#123456');
        expect(shared.update).toHaveBeenCalledTimes(1);
        expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual({ kind: 'artifact', id: 'selected' });
        shared.update.mockClear();
        await act(async () => { storage.getState().updateArtifact(fixture.row('selected', '#ddeeff', 2)); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#123456');
        expect(shared.update).not.toHaveBeenCalled();
        expect(transition).toHaveBeenCalledTimes(1);
        shared.setTheme.mockClear();
        await act(async () => { owner.revert(receipt.previewRef); });
        expect(transition).toHaveBeenCalledTimes(2);
        expect(shared.setTheme).toHaveBeenCalledTimes(1);
        expect(shared.themes!.light.colors.background.canvas).toBe('#ddeeff');
        expect(shared.update).toHaveBeenCalledTimes(1);
        setReducedMotionPreferenceOverride(true);
        await act(async () => { receipt = owner.begin({ document: parsed.document, mode: 'light', origin: { kind: 'editor' } }); });
        expect(transition).toHaveBeenCalledTimes(2);
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
