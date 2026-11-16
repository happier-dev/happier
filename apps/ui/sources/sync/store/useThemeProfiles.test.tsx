import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { readThemeLibrarySnapshot, readThemeProfilesSnapshot, useThemeLibraryEntries, useThemeProfileDocument } from './useThemeProfiles';

await initializeArtifactInventoryDemandHarness();

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
});
