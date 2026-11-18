import { describe, expect, it, vi } from 'vitest';
import { parseThemeProfileDocument, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { RegistryThemeFaceV1Schema, type RegistryThemeAcquisitionV1 } from '@happier-dev/protocol/registries/registryThemeV1';
import type { RegistryProvenanceV1 } from '@happier-dev/protocol/registries/registryItemsV1';
import { createThemeProfileLibrary, type ThemeProfileArtifactAdapter } from '@/theme/profiles/themeProfileLibrary';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import * as themeColors from '@/theme/profiles/deriveThemeColors';
import { clearEffectiveThemeCache, resolveThemeProfileWithPaint } from '@/theme/profiles/resolveThemeProfile';
import { createThemeRegistryLifecycle } from './themeRegistryInstall';
import { createThemeActionExecute } from '@/sync/ops/actions/themeActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

function document(id: string, css?: string) {
    const result = parseThemeProfileDocument({ schemaVersion: 2, id, name: id,
        createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' },
        overrides: { light: {}, dark: {} }, style: { futurePresentation: { glow: true } }, ...(css ? { css } : {}) });
    if (!result.ok) throw new Error('Invalid theme fixture');
    return result.document;
}

function setup(acquisitionGate?: Promise<void>) {
    // Persistence and selected registry acquisition are boundaries; MODEL logic remains real.
    const rows = new Map<string, { document: ReturnType<typeof document>; revision: number; headerVersion: number }>();
    const selection = { light: null as ThemeReference | null, dark: null as ThemeReference | null };
    const failed = new Set<string>();
    let acquisitionFailure: Error | undefined;
    const savedFaces: string[] = [];
    let acquisitions = 0, selections = 0, generated = 0;
    const artifacts: ThemeProfileArtifactAdapter = {
        load: async () => {},
        list: () => [...rows.values()].map(row => ({ entry: projectThemeLibraryEntry(row.document), revision: row.revision, headerVersion: row.headerVersion })),
        get: async id => rows.get(id) ?? null,
        getSummary: async id => {
            const row = rows.get(id);
            return row ? { entry: projectThemeLibraryEntry(row.document), revision: row.revision, headerVersion: row.headerVersion } : null;
        },
        save: async value => {
            const source = value.profile.source;
            const key = source?.kind === 'store' ? source.contributionId : value.profile.id;
            if (failed.has(key)) throw Object.assign(new Error('Storage unavailable'), { code: 'storage_unavailable' });
            savedFaces.push(key);
            const previous = rows.get(value.profile.id);
            const row = { document: value, revision: (previous?.revision ?? 0) + 1, headerVersion: (previous?.headerVersion ?? 0) + 1 };
            rows.set(value.profile.id, row);
            return { id: value.profile.id, ...row, created: previous === undefined };
        },
        delete: async id => { rows.delete(id); },
    };
    const context = { artifacts, readSelection: () => selection,
        writeSelection: (mode: 'light' | 'dark', reference: ThemeReference | null) => { selections++; selection[mode] = reference; },
        createId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++generated).padStart(12, '0')}`, now: () => Date.parse('2026-11-16T12:00Z') };
    const library = createThemeProfileLibrary(context);
    const listing = { sourceId: 'catalog', itemId: 'paper' };
    const options = { expectedScope: { serverId: 'server', accountId: 'account-a' } } as const;
    const themes = ['light', 'dark'].map(mode => ({ key: mode, label: mode, mode: mode as 'light' | 'dark',
        document: document(`store-${mode}`, mode === 'light' ? '.store-detail { color: red; }' : undefined) }));
    const ref = { kind: 'version' as const, version: '1.0.0' };
    const acquired: RegistryThemeAcquisitionV1 = {
        item: { summary: { kind: 'theme', ...listing, title: 'Paper', version: '1.0.0' }, fetchedAt: 0,
            payload: { kind: 'theme', state: 'ready', version: '1.0.0', ref, themes,
                listing: { includes: themes.map(({ key, label, mode }) => ({ key, label, mode })), license: 'LicenseRef-Custom' } } },
        provenance: { ...listing, format: 'git', sourceUrl: 'https://themes.example.test/catalog', ref, importedAt: 0 },
    };
    const reverted: typeof listing[] = [];
    let upstream = acquired;
    const lifecycle = createThemeRegistryLifecycle({ withThemeProfileContext: operation => operation(context), readMode: () => 'dark',
        acquire: async (key, operation): Promise<RegistryThemeAcquisitionV1> => {
            acquisitions++;
            await acquisitionGate;
            operation.signal?.throwIfAborted();
            if (acquisitionFailure) {
                const error = acquisitionFailure;
                acquisitionFailure = undefined;
                throw error;
            }
            const provenance: RegistryProvenanceV1 = operation.expectedScope?.accountId === 'account-b'
                ? { ...upstream.provenance, format: 'git', sourceUrl: 'https://themes.example.test/account-b/catalog', sourceId: key.sourceId, itemId: key.itemId }
                : { ...upstream.provenance, sourceId: key.sourceId, itemId: key.itemId };
            return { ...upstream, item: { ...upstream.item, summary: { ...upstream.item.summary, ...key } }, provenance };
        }, revertStorePreview: key => { reverted.push(key); } });
    return { lifecycle, library, rows, listing, options, failed, savedFaces, acquired, selection, reverted,
        failNextAcquisition: (error: Error) => { acquisitionFailure = error; },
        publishVersion: (version: string) => { const ref = { kind: 'version', version } as const;
            const provenance: RegistryProvenanceV1 = { ...acquired.provenance, ref };
            upstream = { ...acquired,
            item: { ...acquired.item, summary: { ...acquired.item.summary, version },
                payload: { ...acquired.item.payload, version, ref } },
            provenance }; },
        counts: () => ({ acquisitions, selections, writes: savedFaces.length }) };
}

describe('Store theme lifecycle through the MODEL library', () => {
    it('projects visible faces once per acquisition without evicting the live paint palette', async () => {
        const { acquired, listing: baseListing, options } = setup();
        const listings = Array.from({ length: 14 }, (_, index) => ({
            ...baseListing, itemId: `theme-${index}`, version: '1.0.0',
        }));
        const { themes } = acquired.item.payload;
        let acquisitions = 0;
        const lifecycle = createThemeRegistryLifecycle({
            acquire: async listing => {
                acquisitions++;
                const canvas = `#3344${listing.itemId.slice('theme-'.length).padStart(2, '0')}`;
                const faces = themes.map(face => RegistryThemeFaceV1Schema.parse({
                    ...face,
                    document: { ...face.document, raw: { ...face.document.raw,
                        overrides: { light: { 'background.canvas': canvas }, dark: { 'background.canvas': canvas } },
                    } },
                }));
                return {
                    item: { ...acquired.item, summary: { ...acquired.item.summary, ...listing },
                        payload: { ...acquired.item.payload, themes: faces } },
                    provenance: { sourceId: listing.sourceId, itemId: listing.itemId, format: 'git', sourceUrl: 'https://themes.example.test/catalog',
                        ref: acquired.item.payload.ref, importedAt: 0 },
                };
            },
            withThemeProfileContext: async () => { throw new Error('Gallery must not read theme library storage'); },
            readMode: () => 'light',
            revertStorePreview: () => {},
        });
        const liveInput = { mode: 'light' as const, profile: document('live').profile };
        clearEffectiveThemeCache();
        const livePaint = resolveThemeProfileWithPaint(liveInput);
        // Every uncached resolution derives paints once. Count the real work without replacing it.
        const derives = vi.spyOn(themeColors, 'deriveThemeColorsWithPaint');
        try {
            const openPage = () => Promise.all(listings.map(listing => lifecycle.acquirePreview(listing, options)));
            const cards = await openPage();
            const cold = derives.mock.calls.length;
            const first = cards.map(card => card.miniatures);
            const firstMount = derives.mock.calls.length - cold;
            const paintSurvivedFirstMount = resolveThemeProfileWithPaint(liveInput) === livePaint;
            derives.mockClear();
            const reopened = await openPage();
            const reopen = derives.mock.calls.length;
            const paintSurvivedReopen = resolveThemeProfileWithPaint(liveInput) === livePaint;

            expect({ cold, firstMount, reopen, paintSurvivedFirstMount, paintSurvivedReopen }).toEqual({
                cold: listings.length * themes.length, firstMount: 0, reopen: 0,
                paintSurvivedFirstMount: true, paintSurvivedReopen: true,
            });
            for (const [index, card] of reopened.entries()) expect(card.miniatures).toBe(first[index]);
            expect(first[0]).toMatchObject([{ mode: 'light', canvas: '#334400' }, { mode: 'dark', canvas: '#334400' }]);
            expect(first[13]).toMatchObject([{ mode: 'light', canvas: '#334413' }, { mode: 'dark', canvas: '#334413' }]);
            expect(acquisitions).toBe(listings.length);
        } finally {
            derives.mockRestore();
            clearEffectiveThemeCache();
        }
    });

    it('publishes version-scoped non-theme exclusion once, coalescing 60 gallery consumers', async () => {
        const state = setup();
        state.acquired.item.payload.themes.length = 0;
        state.acquired.item.payload.listing.includes.length = 0;
        const listing = { ...state.listing, version: '1.0.0' };
        let publications = 0;
        const unsubscribe = state.lifecycle.subscribePreview(listing, state.options.expectedScope, () => { publications++; });
        expect(state.lifecycle.isPreviewExcluded(listing, state.options.expectedScope)).toBe(false);
        await Promise.all(Array.from({ length: 60 }, () => state.lifecycle.acquirePreview(listing, state.options)));
        expect(state.lifecycle.isPreviewExcluded(listing, state.options.expectedScope)).toBe(true);
        expect(state.lifecycle.isPreviewExcluded({ ...listing, version: '2.0.0' }, state.options.expectedScope)).toBe(false);
        expect(state.lifecycle.isPreviewExcluded(listing, { ...state.options.expectedScope, accountId: 'account-b' })).toBe(false);
        expect(state.counts().acquisitions).toBe(1);
        expect(publications).toBe(1);
        unsubscribe();
    });
    it('acquires each visible package version once and reuses it after listing close and scroll-back', async () => {
        const state = setup();
        const listing = { ...state.listing, version: '1.0.0' };
        const acquired = await state.lifecycle.acquirePreview(listing, state.options);
        const sibling = { ...listing, itemId: 'sibling' };
        await state.lifecycle.acquirePreview(sibling, state.options);
        expect(await state.lifecycle.get({ ...listing }, state.options)).toBe(acquired);
        state.lifecycle.releaseOpened(listing, state.options);
        expect(await state.lifecycle.acquirePreview({ ...listing }, state.options)).toBe(acquired);
        expect(await state.lifecycle.prepareStorePreview(listing, state.options)).toBe(acquired);
        expect(state.counts()).toEqual({ acquisitions: 2, selections: 0, writes: 0 });
        state.publishVersion('2.0.0');
        expect((await state.lifecycle.acquirePreview({ ...listing, version: '2.0.0' }, state.options)).item.payload.version).toBe('2.0.0');
        expect(await state.lifecycle.acquirePreview(listing, state.options)).toBe(acquired);
        await state.lifecycle.install({ listing: state.listing }, state.options);
        expect(state.counts()).toEqual({ acquisitions: 4, selections: 1, writes: 2 });
        expect([...state.rows.values()][0]?.document.profile.source).toMatchObject({ provenance: { ref: { version: '2.0.0' } } });
    });

    it('joins an in-flight card acquisition when its listing opens, independently of card unmount', async () => {
        let finishAcquisition!: () => void;
        const state = setup(new Promise<void>(resolve => { finishAcquisition = resolve; }));
        const listing = { ...state.listing, version: '1.0.0' };
        const controller = new AbortController();
        const card = state.lifecycle.acquirePreview(listing, { ...state.options, signal: controller.signal });
        const opening = state.lifecycle.get(listing, state.options);
        controller.abort();
        finishAcquisition();
        const [cardAcquired, opened] = await Promise.all([card, opening]);
        expect(opened).toBe(cardAcquired);
        expect(await state.lifecycle.prepareStorePreview(listing, state.options)).toBe(opened);
        expect(state.counts()).toEqual({ acquisitions: 1, selections: 0, writes: 0 });
    });

    it('isolates cached package versions by Account, Home and registry source', async () => {
        const state = setup();
        const listing = { ...state.listing, version: '1.0.0' };
        const acquired = await state.lifecycle.acquirePreview(listing, state.options);
        const anotherAccount = { expectedScope: { serverId: 'server', accountId: 'account-b' } };
        expect((await state.lifecycle.get(listing, anotherAccount)).provenance.sourceUrl).toContain('account-b');
        await state.lifecycle.acquirePreview(listing, { expectedScope: { serverId: 'another-server', accountId: 'account-a' } });
        await state.lifecycle.acquirePreview({ ...listing, sourceId: 'another-source' }, state.options);
        expect(await state.lifecycle.acquirePreview({ ...listing }, { expectedScope: { ...state.options.expectedScope } })).toBe(acquired);
        await state.lifecycle.acquirePreview(listing, { expectedScope: null });
        await state.lifecycle.acquirePreview(listing, { expectedScope: null });
        expect(state.counts()).toEqual({ acquisitions: 6, selections: 0, writes: 0 });
    });

    it('retains failed card acquisitions on scroll-back while explicit listing recovery can retry', async () => {
        const state = setup();
        const listing = { ...state.listing, version: '1.0.0' };
        state.failNextAcquisition(Object.assign(new Error('Registry unavailable'), { code: 'registry_unavailable' }));
        await expect(state.lifecycle.acquirePreview(listing, state.options)).rejects.toMatchObject({ code: 'registry_unavailable' });
        await expect(state.lifecycle.acquirePreview({ ...listing }, state.options)).rejects.toMatchObject({ code: 'registry_unavailable' });
        expect(state.counts()).toEqual({ acquisitions: 1, selections: 0, writes: 0 });
        const acquired = await state.lifecycle.get(listing, state.options);
        expect(await state.lifecycle.acquirePreview(listing, state.options)).toBe(acquired);
        expect(await state.lifecycle.get(listing, state.options)).toBe(acquired);
        expect(state.counts()).toEqual({ acquisitions: 2, selections: 0, writes: 0 });
    });

    it('reuses opened content for preview, installs every face and publishes nothing on an unchanged repeat', async () => {
        const state = setup();
        const acquired = await state.lifecycle.get(state.listing, state.options);
        expect(await state.lifecycle.prepareStorePreview(state.listing, state.options)).toBe(acquired);
        const result = await state.lifecycle.install({ listing: state.listing }, state.options);
        expect(result.faces.map(face => face.status)).toEqual(['saved', 'saved']);
        expect(state.counts()).toEqual({ acquisitions: 2, selections: 1, writes: 2 });
        expect(state.selection.dark).not.toBeNull();
        for (const row of state.rows.values()) {
            expect(row.document.profile.source).toMatchObject({ kind: 'store', provenance: acquired.provenance });
            expect(row.document.raw.style).toEqual({ futurePresentation: { glow: true } });
        }
        await state.lifecycle.install({ listing: state.listing }, state.options);
        expect(state.counts()).toEqual({ acquisitions: 3, selections: 1, writes: 2 });
    });

    it('Store Keep uses its retained package even after another listing opens', async () => {
        const state = setup();
        const acquired = await state.lifecycle.get(state.listing, state.options);
        const face = acquired.item.payload.themes[1]!;
        state.publishVersion('2.0.0');
        await state.lifecycle.get({ sourceId: 'catalog', itemId: 'another' }, state.options);
        const kept = await state.lifecycle.keepStore({ previewRef: 'preview', document: face.document, mode: face.mode,
            origin: { kind: 'store', listing: state.listing, acquired } }, state.options);
        expect(kept.entry?.source).toMatchObject({ kind: 'store', contributionId: 'dark' });
        expect(kept.entry?.source).toMatchObject({ provenance: { ref: { kind: 'version', version: '1.0.0' } } });
        expect(state.counts()).toEqual({ acquisitions: 2, selections: 1, writes: 2 });
        expect(kept.undo).toBeDefined();
    });

    it('explicit Install acquires the latest package after inspecting an older version', async () => {
        const state = setup();
        await state.lifecycle.get(state.listing, state.options);
        state.publishVersion('2.0.0');
        await state.lifecycle.install({ listing: state.listing }, state.options);
        expect([...state.rows.values()].map(row => row.document.profile.source)).toMatchObject([
            { kind: 'store', provenance: { ref: { kind: 'version', version: '2.0.0' } } },
            { kind: 'store', provenance: { ref: { kind: 'version', version: '2.0.0' } } },
        ]);
        expect(state.counts().acquisitions).toBe(2);
    });

    it('closing an opened listing releases its faces while Keep retains the inspected package', async () => {
        const state = setup();
        const acquired = await state.lifecycle.get(state.listing, state.options);
        const face = acquired.item.payload.themes[1]!;
        state.lifecycle.releaseOpened({ ...state.listing, itemId: 'another' }, state.options);
        state.lifecycle.releaseOpened(state.listing, { expectedScope: { serverId: 'server', accountId: 'account-b' } });
        expect(await state.lifecycle.prepareStorePreview(state.listing, state.options)).toBe(acquired);
        state.lifecycle.releaseOpened(state.listing, state.options);
        state.publishVersion('2.0.0');
        expect((await state.lifecycle.prepareStorePreview(state.listing, state.options)).item.payload.version).toBe('2.0.0');
        const kept = await state.lifecycle.keepStore({ previewRef: 'preview', document: face.document, mode: face.mode,
            origin: { kind: 'store', listing: state.listing, acquired } }, state.options);
        expect(kept.entry?.source).toMatchObject({ kind: 'store', contributionId: 'dark',
            provenance: { ref: { kind: 'version', version: '1.0.0' } } });
        expect(state.counts().acquisitions).toBe(2);
    });

    it('does not retain an acquisition that finishes after its listing closes', async () => {
        let finishAcquisition!: () => void;
        const acquisitionGate = new Promise<void>(resolve => { finishAcquisition = resolve; });
        const state = setup(acquisitionGate);
        const controller = new AbortController();
        const options = { ...state.options, signal: controller.signal };
        const opening = state.lifecycle.get(state.listing, options);
        controller.abort();
        state.lifecycle.releaseOpened(state.listing, options);
        finishAcquisition();
        await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
        state.publishVersion('2.0.0');
        expect((await state.lifecycle.prepareStorePreview(state.listing, state.options)).item.payload.version).toBe('2.0.0');
        expect(state.counts().acquisitions).toBe(2);
    });

    it('reports partial failure and retries only requested failed faces without losing the saved face', async () => {
        const state = setup();
        state.failed.add('dark');
        await expect(state.lifecycle.install({ listing: state.listing }, state.options)).rejects.toMatchObject({
            code: 'theme_install_partial', details: { faces: [
                { faceId: 'light', status: 'saved' }, { faceId: 'dark', status: 'failed', error: { code: 'storage_unavailable' } },
            ] },
        });
        expect(state.rows.size).toBe(1);
        expect(state.selection.dark).toBeNull();
        state.failed.clear();
        await state.lifecycle.install({ listing: state.listing, faceIds: ['dark'] }, state.options);
        expect(state.savedFaces).toEqual(['light', 'dark']);
        expect(state.rows.size).toBe(2);
        expect(state.counts()).toEqual({ acquisitions: 2, selections: 1, writes: 2 });
    });

    it('preserves the previous selection when another face fails', async () => {
        const state = setup();
        const previous = { kind: 'built-in', presetId: 'premiumDark' } as const;
        await state.library.select({ mode: 'dark', reference: previous });
        state.failed.add('light');
        await expect(state.lifecycle.install({ listing: state.listing }, state.options))
            .rejects.toMatchObject({ code: 'theme_install_partial' });
        expect(state.selection.dark).toEqual(previous);
        expect(state.counts().selections).toBe(1);
        expect(state.rows.size).toBe(1);
    });

    it('uninstalls by canonical listing provenance while preserving a user duplicate and siblings', async () => {
        const state = setup();
        await state.lifecycle.install({ listing: state.listing }, state.options);
        const original = (await state.library.list()).find(entry => entry.source.kind === 'store')!;
        const duplicate = await state.library.duplicate({ reference: original.reference });
        const own = await state.library.save({ document: document('own') });
        const result = await state.lifecycle.uninstall(state.listing, state.options);
        expect(result.removedFaces).toEqual(['light', 'dark']);
        expect([...state.rows.keys()].sort()).toEqual([duplicate.entry!.id, own.entry!.id].sort());
        expect(state.reverted).toEqual([state.listing]);
        expect(state.counts().acquisitions).toBe(1);
    });

    it('reacquires the same listing for another Account instead of installing retained private content', async () => {
        const state = setup();
        await state.lifecycle.get(state.listing, state.options);
        await state.lifecycle.install({ listing: state.listing }, { expectedScope: { serverId: 'server', accountId: 'account-b' } });
        expect(state.counts()).toEqual({ acquisitions: 2, selections: 1, writes: 2 });
        expect([...state.rows.values()].map(row => row.document.profile.source)).toMatchObject([
            { kind: 'store', provenance: { sourceUrl: 'https://themes.example.test/account-b/catalog' } },
            { kind: 'store', provenance: { sourceUrl: 'https://themes.example.test/account-b/catalog' } },
        ]);
    });
});


describe('Store lifecycle at the client Action host', () => {
    it('gets sourced preview documents, installs through MODEL and preserves partial face recovery details', async () => {
        const state = setup();
        const executor = createActionExecutor({ themeAction: createThemeActionExecute({
            withLibrary: operation => operation(state.library), clientId: () => '', readSelection: () => state.selection,
            withRegistryLifecycle: operation => operation({
                get: listing => state.lifecycle.get(listing, state.options),
                prepareStorePreview: listing => state.lifecycle.prepareStorePreview(listing, state.options),
                install: input => state.lifecycle.install(input, state.options),
                uninstall: listing => state.lifecycle.uninstall(listing, state.options),
            }),
        }) });
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const acquired = await executor.execute('appearance.themes.store.get', { listing: state.listing }, context);
        expect(acquired).toMatchObject({ ok: true, result: { listing: { pointer: { ...state.listing, version: '1.0.0' },
            summary: { kind: 'theme' }, metadata: { includes: [{ key: 'light' }, { key: 'dark' }] },
            provenance: state.acquired.provenance },
            faces: [{ profile: { source: { kind: 'store', contributionId: 'light' } } },
                { profile: { source: { kind: 'store', contributionId: 'dark' } } }],
            coverage: [{ faceId: 'light', coverage: { total: 1, native: 0, webOnly: 1 } },
                { faceId: 'dark', coverage: { total: 0, native: 0, webOnly: 0 } }] } });
        state.failed.add('dark');
        expect(await executor.execute('appearance.themes.install', { listing: state.listing }, context))
            .toMatchObject({ ok: false, errorCode: 'theme_install_partial', details: { faces: [
                { faceId: 'light', status: 'saved' }, { faceId: 'dark', status: 'failed', error: { code: 'storage_unavailable' } },
            ] } });
        state.failed.clear();
        expect(await executor.execute('appearance.themes.install', { listing: state.listing, faceIds: ['dark'] }, context))
            .toMatchObject({ ok: true, result: { faces: [{ faceId: 'dark', status: 'saved' }] } });
        expect(state.counts()).toEqual({ acquisitions: 3, selections: 1, writes: 2 });
        expect(await executor.execute('appearance.themes.uninstall', { listing: state.listing }, context))
            .toMatchObject({ ok: true, result: { removedFaces: ['light', 'dark'] } });
        expect(state.rows.size).toBe(0);
    });
});
