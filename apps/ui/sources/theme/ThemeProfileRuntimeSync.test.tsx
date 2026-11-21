import * as React from 'react';
import type { ThemeActionId, ThemeActionInput, ThemeActionOutput, ThemeActionRequest } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
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
    machineRpc: vi.fn(),
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
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(shared.machineRpc));

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

describe('Theme runtime synchronization', () => {
    it('cold-loads the saved plugin theme and falls back when its Machine reports uninstall with the catalog closed', async () => {
        const fixture = await setup();
        const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection, readPluginAccountAvailability }
            = await import('@/sync/domains/plugins/availability/projection');
        const { PluginProjectionV2Schema, buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeRequestSchema }
            = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const { resolveMachineReachability } = await import('@/sync/domains/machines/reachability/machineReachability');
        const pluginId = 'fixture.startup-theme';
        const machineId = 'startup-theme-machine';
        const occurrenceId = 'startup-theme-occurrence';
        const theme = { schemaVersion: 1, id: 'paper', name: 'Paper', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: { 'background.canvas': '#224466' }, dark: {} } };
        const materialization = { serverIdentityId: fixture.scope.serverId, machineId, materializationId: occurrenceId,
            pluginId, version: '1.0.0', sourceClass: 'localPath' as const, portableRelease: false, uiArtifacts: [],
            enabled: true, trustState: 'trusted' as const, observedAt: 1 };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Paper palette', version: '1.0.0', enabled: true, occurrenceId,
                source: { kind: 'localPath', locator: '/fixture/startup-theme' } } },
            familiesById: { themes: { family: 'themes', entriesById: { [`${pluginId}/paper`]: {
                id: `${pluginId}/paper`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: { id: 'paper', theme },
            } } }, registrySources: { family: 'registrySources', entriesById: {} } },
        });
        const deferred = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection });
        let currentProjection = deferred;
        const sectionReads: string[] = [];
        shared.machineRpc.mockImplementation(async ({ method, payload }) => {
            expect(method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(payload);
            if (!('sectionRead' in request) || !request.sectionRead) return currentProjection.manifest;
            const { digest, offset, includeDigests } = request.sectionRead;
            sectionReads.push(digest, ...includeDigests ?? []);
            return currentProjection.read(digest, offset, includeDigests);
        });
        onTestFinished(() => { shared.machineRpc.mockReset(); clearPluginAccountAvailabilityProjection(); });
        storage.setState({ endpointStatus: 'online', isDataReady: true });
        const machine = createMachineFixture({ id: machineId, active: true, activeAt: Date.now(), storageMode: 'plain',
            daemonStateVersion: 1, daemonState: { contributionRegistryProjectionRevision: 1 } });
        await publishMachineInventoryForTest(fixture.scope, [machine]);
        expect(resolveMachineReachability(fixture.scope, machine)).toBe('reachable');
        replacePluginAccountAvailabilityProjection({ scope: fixture.scope, snapshot: { availabilityCursor: 1,
            intentReads: [], materializations: [materialization], snapshots: [{ serverIdentityId: fixture.scope.serverId,
                machineId, materializations: [materialization] }] } });
        expect(readPluginAccountAvailability(fixture.scope).readInstalledPlugins()).toMatchObject({ kind: 'available',
            plugins: [{ pluginId, installations: [{ materialization }] }] });
        const shell = <><ThemeProfileRuntimeSync /><AppShellPluginUiProjectionProvider>{null}</AppShellPluginUiProjectionProvider></>;
        const idle = await renderScreen(shell);
        expect(shared.themes!.light.colors.background.canvas).toBe('#f1e2d3');
        expect(shared.machineRpc).not.toHaveBeenCalled();
        await idle.unmount();

        storage.getState().applyLocalSettings({ themeProfileSelection: { light: { kind: 'plugin', pluginId, contributionId: 'paper' }, dark: null } });
        shared.themes = { light: lightTheme, dark: darkTheme };
        const cold = await renderScreen(shell);
        await vi.waitFor(() => {
            const demandedFamilies = Object.entries(deferred.manifest.sections)
                .filter(([section, digest]) => section.startsWith('familiesById.') && sectionReads.includes(digest))
                .map(([section]) => section);
            expect({ demandedFamilies, canvas: shared.themes!.light.colors.background.canvas })
                .toEqual({ demandedFamilies: ['familiesById.themes'], canvas: '#224466' });
        });
        const reference = { kind: 'plugin', pluginId, contributionId: 'paper' };
        const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const readTheme = () => readCurrentAppShellPluginUiProjection({ scope: fixture.scope, declarationsOnly: true })
            ?.themesById[`${pluginId}/paper`];
        const installedTheme = readTheme();
        expect(installedTheme?.definition.theme.name).toBe('Paper');
        try {
            const sectionReadsBeforeUninstall = sectionReads.length;
            await act(async () => {
                replacePluginAccountAvailabilityProjection({ scope: fixture.scope, snapshot: { availabilityCursor: 2,
                    intentReads: [], materializations: [], snapshots: [], inventoryComplete: false } });
            });
            expect(readTheme()).toBe(installedTheme);
            currentProjection = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'b'.repeat(64),
                projection: { ...projection, generation: 2, installedPackagesById: {},
                    familiesById: { ...projection.familiesById, themes: { family: 'themes', entriesById: {} } } } });
            await act(async () => {
                replacePluginAccountAvailabilityProjection({ scope: fixture.scope, snapshot: { availabilityCursor: 3,
                    intentReads: [], materializations: [], snapshots: [{ serverIdentityId: fixture.scope.serverId,
                        machineId, materializations: [] }] } });
            });
            await act(async () => {
                await publishMachineInventoryForTest(fixture.scope, [{ ...machine, daemonStateVersion: 2,
                    daemonState: { contributionRegistryProjectionRevision: 2 } }]);
            });
            await vi.waitFor(() => {
                expect(readTheme()).toBeUndefined();
                expect(shared.themes!.light.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
            });
            expect(sectionReads).toHaveLength(sectionReadsBeforeUninstall);
            expect(storage.getState().localSettings.themeProfileSelection?.light).toEqual(reference);
        } finally { await cold.unmount(); }
    });

    it('applies each mode press once when its settings publication flushes synchronously', async () => {
        const fixture = await setup();
        const { themeModeStorageBinding } = await import('@/components/settings/appearance/themeModeSettingBinding');
        let revision = 0;
        let renders = 0;
        let commits = 0;
        const listeners = new Set<() => void>();
        const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
        shared.setTheme.mockImplementation(() => { revision++; for (const listener of listeners) listener(); });
        onTestFinished(() => { shared.setTheme.mockReset(); });
        function ThemedConsumer() {
            React.useSyncExternalStore(subscribe, () => revision);
            renders++;
            return null;
        }
        const screen = await renderScreen(<><ThemeProfileRuntimeSync />
            <React.Profiler id="theme-consumer" onRender={() => { commits++; }}><ThemedConsumer /></React.Profiler></>);
        const transition = vi.fn((mutation: () => void) => mutation());
        const unregister = registerNativeThemePreferenceTransitionController({ run: transition });
        setReducedMotionPreferenceOverride(false);
        onTestFinished(() => { unregister(); setReducedMotionPreferenceOverride(null); });
        for (const preference of ['dark', 'light', 'dark', 'light', 'dark', 'light'] as const) {
            transition.mockClear();
            shared.setTheme.mockClear();
            const before = { renders, commits };
            await themeModeStorageBinding.commit(storage.getState().localSettings, preference,
                delta => { act(() => { storage.getState().applyLocalSettings(delta); }); },
                { accountScope: fixture.scope, isCurrent: () => true });
            await act(async () => {});
            expect(storage.getState().localSettings.themePreference).toBe(preference);
            expect(transition).toHaveBeenCalledTimes(1);
            expect(shared.setTheme).toHaveBeenCalledTimes(1);
            expect(shared.setTheme).toHaveBeenLastCalledWith(preference);
            expect(renders - before.renders).toBe(1);
            expect(commits - before.commits).toBe(1);
        }
        await screen.unmount();
    });
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
    it('debounces draft keystrokes into one quiet application while explicit Try still reveals once', async () => {
        await setup();
        const { createThemeActionHarness } = await import('@/dev/testkit/harness/themeActionHarness');
        const { createThemeActionExecute } = await import('@/sync/ops/actions/themeActionDeps');
        const { ThemeActionInputSchemas, ThemeActionOutputSchemas } = await import('@happier-dev/protocol/actions/themeActionFamily');
        const { createThemeProfileEditorActions } = await import('@/components/settings/appearance/themeProfiles/themeProfileEditorActions');
        const { useThemeProfileEditorPreview } = await import('@/components/settings/appearance/themeProfiles/useThemeProfileEditorPreview');
        const { getThemeTryOnOwner } = await import('./profiles/themeTryOnRuntime');
        const { prepareThemeProfileCss } = await import('./css/prepareThemeCss');
        const harness = createThemeActionHarness();
        const owner = getThemeTryOnOwner();
        const action = createThemeActionExecute({ withLibrary: operation => operation(harness.library),
            readSelection: () => harness.selection, clientId: () => '', runtime: { preview: owner,
                coverage: value => prepareThemeProfileCss(value.profile).coverage,
                detailedCoverage: value => prepareThemeProfileCss(value.profile).detailedCoverage, surfaceMap: () => [] } });
        const editor = createThemeProfileEditorActions(async <Id extends ThemeActionId,>(id: Id, input: ThemeActionInput<Id>): Promise<ThemeActionOutput<Id>> => {
            const admitted = ThemeActionInputSchemas[id].parse(input);
            const result = await action({ actionId: id, input: admitted, context: { surface: 'ui' } } as ThemeActionRequest);
            return ThemeActionOutputSchemas[id].parse(result) as ThemeActionOutput<Id>;
        });
        const onFailure = (error: unknown) => { throw error; };
        function Draft({ document }: { document: ThemeProfileDocument }) {
            useThemeProfileEditorPreview({ owner, draft: { document, mode: 'light' }, preview: editor.preview, onFailure });
            return <ThemeProfileRuntimeSync />;
        }
        const { parseThemeProfileDocument, mergeThemeProfileDocumentEdit } = await import('@happier-dev/protocol/account/settings/themeProfiles');
        const parsed = parseThemeProfileDocument({ schemaVersion: 1, id: 'draft', name: 'Draft', createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } });
        if (!parsed.ok) throw new Error('Invalid draft');
        const screen = await renderScreen(<Draft document={parsed.document} />);
        const transition = vi.fn((mutation: () => void) => mutation());
        const unregister = registerNativeThemePreferenceTransitionController({ run: transition });
        setReducedMotionPreferenceOverride(false);
        onTestFinished(() => { unregister(); setReducedMotionPreferenceOverride(null); vi.useRealTimers(); });
        vi.useFakeTimers();
        shared.update.mockClear();
        let latest = parsed.document;
        for (let i = 0; i < 10; i++) {
            latest = mergeThemeProfileDocumentEdit(parsed.document, { overrides: { light: { 'background.canvas': `#12345${i}` }, dark: {} } });
            await screen.update(<Draft document={latest} />);
        }
        expect(shared.update).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(shared.themes!.light.colors.background.canvas).toBe('#123459');
        expect(transition).not.toHaveBeenCalled();
        expect(shared.update).toHaveBeenCalledTimes(1);
        expect(harness.writes()).toBe(0);
        await act(async () => { owner.begin({ document: parsed.document, mode: 'dark', origin: { kind: 'agent' } }); });
        expect(transition).toHaveBeenCalledTimes(1);
        await screen.unmount();
        const current = owner.read();
        if (current) await act(async () => { owner.revert(current.previewRef); });
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
