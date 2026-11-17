import * as React from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiThemeProjection } from '@/sync/domains/plugins/ui/projection';
import { createThemeProfileDraft } from '@/theme/profiles/createThemeProfileDraft';
import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { readThemeLibrarySnapshot, readThemeProfilesSnapshot, useThemeLibraryEntries, useThemeLibraryEntry, useThemeLibraryInventory, useThemeProfileDocument, useThemeProfileReferenceSelection } from './useThemeProfiles';


async function home(suffix: string) {
    const fixture = await createPlainArtifactHomeFixture(`https://theme-source-${suffix}.test`, { currentAccount: true });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
    const row = (index: number): DecryptedArtifact => ({
        id: `theme-${index}`, sourceServerId: scope.serverId, ownerAccountId: scope.accountId, access: 'owner', isDecrypted: true,
        title: `Theme ${index}`, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0,
        rawHeader: { v: 1, kind: 'theme_profile.v1', title: `Theme ${index}`, mode: 'dark', themeSource: { kind: 'yours' },
            compatibility: { status: 'partial', unsupportedPaths: ['style.futurePresentation'] },
            palette: { overrides: { 'background.canvas': '#172033' }, radius: 'soft' } },
        body: JSON.stringify({ schemaVersion: 2, id: `theme-${index}`, name: `Theme ${index}`, createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: 'dark',
            style: { futurePresentation: { glow: true } }, css: '.surface { color: red; }'.repeat(1000) }),
    });
    return { ...fixture, scope, row };
}

describe('Artifact-backed theme source', () => {
    it('defers hidden library demand and preserves warm presented recovery', async () => {
        await initializeArtifactInventoryDemandHarness();
        const fixture = await createArtifactInventoryDemandHarness();
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        fixture.inventory = [];
        fixture.pages.length = 0;
        const hook = await renderHook((enabled: boolean) => useThemeLibraryInventory(enabled), { initialProps: false });
        await flushHookEffects();
        await fixture.settleInventory();
        expect(fixture.pages).toEqual([]);
        await hook.rerender(true);
        await vi.waitFor(() => expect(hook.getCurrent().loaded).toBe(true));
        expect(fixture.pages).toEqual([{ kinds: '["theme_profile.v1"]', headers: 0 }]);
        await hook.rerender(false);
        await fixture.settleInventory();
        expect(fixture.pages).toHaveLength(1);
        await hook.rerender(true);
        await vi.waitFor(() => expect(hook.getCurrent().loaded).toBe(true));
        expect(fixture.pages).toHaveLength(1);
        expect(fixture.bodyReads).toEqual([]);
    });
    it('does no detail work on hidden header arrivals and opens current headers', async () => {
        const fixture = await home('hidden-arrivals');
        storage.getState().applyArtifacts([fixture.row(0)], {}, ['theme_profile.v1']);
        let renders = 0;
        const hook = await renderHook((enabled: boolean) => { renders++; return useThemeLibraryInventory(enabled); }, { initialProps: false });
        const hidden = hook.getCurrent().entries;
        renders = 0;
        for (let index = 1; index <= 10; index++) {
            await act(async () => { storage.getState().updateArtifact(fixture.row(index)); });
        }
        expect(renders).toBe(0);
        expect(hook.getCurrent().entries).toBe(hidden);
        expect(hidden).toEqual([]);
        await hook.rerender(true);
        expect(hook.getCurrent().entries.filter(entry => entry.source.kind === 'yours')).toHaveLength(11);
    });

    it('reads the captured Account selection from loaded documents and rejects another Account scope', async () => {
        const fixture = await home('captured');
        storage.getState().applyArtifacts([fixture.row(0)]);
        storage.getState().applyLocalSettings({ themeProfileSelection: { light: null, dark: { kind: 'artifact', id: 'theme-0' } } });
        expect(readThemeProfilesSnapshot(fixture.scope).themeProfiles.activeProfileIds.dark).toBe('theme-0');
        expect(readThemeProfilesSnapshot({ ...fixture.scope, accountId: 'another' }).themeProfiles.profiles).toEqual([]);
    });

    it('keeps all forty header entries visible and stable through unrelated Artifact publications', async () => {
        const fixture = await home('headers');
        storage.getState().applyArtifacts(Array.from({ length: 40 }, (_, index) => fixture.row(index)), {}, ['theme_profile.v1']);
        expect(readThemeLibrarySnapshot(fixture.scope)?.entries.filter(entry => entry.source.kind === 'yours')).toHaveLength(40);
        expect(readThemeLibrarySnapshot({ ...fixture.scope, accountId: 'another' })).toBeNull();
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useThemeLibraryEntries(); });
        expect(hook.getCurrent().filter(entry => entry.source.kind === 'yours')).toHaveLength(40);
        const entries = hook.getCurrent();
        renders = 0;
        await act(async () => { storage.getState().updateArtifact({ ...fixture.row(100), rawHeader: { kind: 'markdown' } }); });
        expect(hook.getCurrent()).toBe(entries);
        expect(renders).toBe(0);
        expect(fixture.requests.filter(request => request.path.startsWith('/v1/artifacts/') && request.projection !== 'headers')).toEqual([]);
    });

    it('reads one retained card header without acquiring a body or observing other themes', async () => {
        const fixture = await home('card-header');
        storage.getState().applyArtifacts(Array.from({ length: 40 }, (_, index) => fixture.row(index)), {}, ['theme_profile.v1']);
        let renders = 0;
        const artifactReads = () => fixture.requests.filter(request => request.path.startsWith('/v1/artifacts')).length;
        const readsBefore = artifactReads();
        const reference = { kind: 'artifact', id: 'theme-0' } as const;
        const hook = await renderHook(() => { renders++; return useThemeLibraryEntry(reference); });
        const entry = hook.getCurrent();
        renders = 0;
        await act(async () => { storage.getState().updateArtifact({ ...fixture.row(1), title: 'Changed other theme' }); });
        expect(renders).toBe(0);
        expect(hook.getCurrent()).toBe(entry);
        expect(entry?.name).toBe('Theme 0');
        expect(artifactReads()).toBe(readsBefore);
    });

    it('demands a retained document by tagged reference and admits trusted reserved built-ins', async () => {
        const fixture = await home('document');
        storage.getState().applyArtifacts([fixture.row(0)]);
        const hook = await renderHook(() => useThemeProfileDocument({ kind: 'artifact', id: 'theme-0' }));
        expect(hook.getCurrent().state).toBe('ready');
        expect(hook.getCurrent().document?.raw.schemaVersion).toBe(2);
        expect(hook.getCurrent().document?.raw.style).toEqual({ futurePresentation: { glow: true } });
        const builtIn = await renderHook(() => useThemeProfileDocument({ kind: 'built-in', presetId: 'premiumDark' }));
        expect(builtIn.getCurrent().state).toBe('ready');
        expect(builtIn.getCurrent().document?.profile.source).toEqual({ kind: 'built-in', presetId: 'premiumDark' });
    });

    it('withdraws hidden document subscriptions and reads the current document when presented again', async () => {
        const fixture = await home('hidden-document');
        storage.getState().applyArtifacts([fixture.row(0)]);
        const reference = { kind: 'artifact', id: 'theme-0' } as const;
        let renders = 0;
        const hook = await renderHook((enabled: boolean) => { renders++; return useThemeProfileDocument(reference, enabled); },
            { initialProps: true });
        expect(hook.getCurrent().document?.profile.name).toBe('Theme 0');
        await hook.rerender(false);
        const requests = fixture.requests.length;
        renders = 0;
        for (let index = 1; index <= 10; index++) {
            const row = fixture.row(0);
            await act(async () => storage.getState().updateArtifact({ ...row, bodyVersion: index + 1,
                body: JSON.stringify({ ...JSON.parse(row.body as string), name: `Changed ${index}` }) }));
        }
        expect(renders).toBe(0);
        expect(fixture.requests).toHaveLength(requests);
        await hook.rerender(true);
        expect(hook.getCurrent().document?.profile.name).toBe('Changed 10');
    });

    it('retains a plugin document without rendering hidden declarations and resumes with current content', async () => {
        await home('hidden-plugin');
        const reference = { kind: 'plugin', pluginId: 'sample.palette', contributionId: 'night' } as const;
        const entry = (name: string): PluginUiThemeProjection => ({
            id: 'sample.palette/night', pluginId: reference.pluginId, pluginVersion: '1.0.0',
            definition: { id: reference.contributionId, theme: createThemeProfileDraft({ id: 'night', name, now: '2026-11-16' }) },
        });
        const value = (name: string): AppShellPluginUiProjectionValue => ({
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, themesById: { 'sample.palette/night': entry(name) } },
            pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: null, connectedAccountProjectionRevision: 0,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        });
        let renders = 0;
        let read: ReturnType<typeof useThemeProfileDocument> | null = null;
        let header: ReturnType<typeof useThemeLibraryEntry> = null;
        const Probe = React.memo(function Probe({ enabled }: { enabled: boolean }) {
            renders++;
            read = useThemeProfileDocument(reference, enabled);
            header = useThemeLibraryEntry(reference, enabled);
            return null;
        });
        const shown = <Probe enabled />;
        const hidden = <Probe enabled={false} />;
        const surface = (name: string, child: React.ReactNode) => <AppShellPluginUiProjectionValueProvider value={value(name)}>{child}</AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(surface('Original', hidden));
        const currentHeader = (): ReturnType<typeof useThemeLibraryEntry> => header;
        expect(currentHeader()?.name).toBe('Original');
        await screen.update(surface('Original', shown));
        const current = () => read as ReturnType<typeof useThemeProfileDocument> | null;
        expect(current()?.document?.profile.name).toBe('Original');
        await screen.update(surface('Original', hidden));
        expect(current()?.document?.profile.name).toBe('Original');
        expect(currentHeader()?.name).toBe('Original');
        renders = 0;
        for (let index = 1; index <= 10; index++) await screen.update(surface(`Changed ${index}`, hidden));
        expect(renders).toBe(0);
        expect(current()?.document?.profile.name).toBe('Original');
        await screen.update(surface('Changed 10', shown));
        expect(current()?.document?.profile.name).toBe('Changed 10');
    });

    it('withdraws hidden reference selection updates and resumes with the latest selection', async () => {
        await home('hidden-selection');
        let renders = 0;
        const hook = await renderHook((enabled: boolean) => { renders++; return useThemeProfileReferenceSelection(enabled); }, { initialProps: true });
        await hook.rerender(false);
        renders = 0;
        for (let index = 1; index <= 10; index++) await act(async () => storage.getState().applyLocalSettings({
            themeProfileSelection: { light: null, dark: { kind: 'artifact', id: `theme-${index}` } },
        }));
        expect(renders).toBe(0);
        await hook.rerender(true);
        expect(hook.getCurrent().dark).toEqual({ kind: 'artifact', id: 'theme-10' });
    });

    it('does no hidden transcript header work and resumes with the current addressed header', async () => {
        const fixture = await home('hidden-card-header');
        storage.getState().applyArtifacts([fixture.row(0)]);
        const reference = { kind: 'artifact', id: 'theme-0' } as const;
        let renders = 0;
        const hook = await renderHook((enabled: boolean) => { renders++; return useThemeLibraryEntry(reference, enabled); }, { initialProps: true });
        await hook.rerender(false);
        const requests = fixture.requests.length;
        renders = 0;
        for (let index = 1; index <= 10; index++) await act(async () => storage.getState().updateArtifact({
            ...fixture.row(0), title: `Changed ${index}`, rawHeader: { ...ThemeProfileArtifactHeaderSchema.parse(fixture.row(0).rawHeader), title: `Changed ${index}` },
        }));
        expect(renders).toBe(0);
        expect(fixture.requests).toHaveLength(requests);
        await hook.rerender(true);
        expect(hook.getCurrent()?.name).toBe('Changed 10');
    });
});
