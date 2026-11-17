import { describe, expect, it } from 'vitest';
import { parseThemeProfileDocument, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createThemeProfileLibrary, createThemeProfileSourceAdapter, type ThemeProfileArtifactAdapter } from './themeProfileLibrary';
import { projectPluginThemeLibraryEntries, projectThemeLibraryEntries, projectThemeLibraryEntry } from './themeProfilePresentation';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';

const ids = { first: '11111111-1111-4111-8111-111111111111', second: '22222222-2222-4222-8222-222222222222', kept: '33333333-3333-4333-8333-333333333333' };
function document(id: string, extra: Record<string, unknown> = {}) {
    const parsed = parseThemeProfileDocument({ schemaVersion: 1, id, name: id, createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: 'dark', ...extra });
    if (!parsed.ok) throw new Error('Invalid fixture');
    return parsed.document;
}
const provenance = (changed = false) => ({ sourceId: 'registry', format: 'git', sourceUrl: 'https://registry.example.test', itemId: 'package', ref: { kind: 'gitTree', repo: 'https://registry.example.test/themes.git', path: 'theme', commit: changed ? 'second' : 'first', treeSha: changed ? 'second-tree' : 'first-tree' }, importedAt: 0 });
const ref = (id: string): ThemeReference => ({ kind: 'artifact', id });

function setup(acknowledgeCreation = true, initialPreference?: ThemePreference) {
    const records = new Map<string, { document: ReturnType<typeof document>; revision: number; headerVersion: number }>();
    let reads = 0, writes = 0, deletes = 0, generated = 0, headerVisits = 0;
    const selection = { light: null as ThemeReference | null, dark: null as ThemeReference | null };
    const preference = { value: initialPreference };
    const selectionPublications: { selection: typeof selection; preference: ThemePreference | undefined }[] = [];
    const artifacts: ThemeProfileArtifactAdapter = {
        load: async () => {},
        list: () => [...records.values()].map(row => { headerVisits++; return ({ entry: projectThemeLibraryEntry(row.document), revision: row.revision, headerVersion: row.headerVersion }); }),
        get: async id => { reads++; return records.get(id) ?? null; },
        getSummary: async id => {
            const row = records.get(id);
            return row ? { entry: projectThemeLibraryEntry(row.document), revision: row.revision, headerVersion: row.headerVersion } : null;
        },
        save: async (value, expectedRevision) => {
            writes++;
            const previous = records.get(value.profile.id);
            if (previous && previous.revision !== expectedRevision) throw new Error('version_mismatch');
            const row = { document: value, revision: (previous?.revision ?? 0) + 1, headerVersion: (previous?.headerVersion ?? 0) + 1 };
            records.set(value.profile.id, row);
            return { id: value.profile.id, revision: row.revision, headerVersion: row.headerVersion, document: row.document, ...(acknowledgeCreation ? { created: !previous } : {}) };
        },
        delete: async (id, expectedRevision) => {
            deletes++;
            if (expectedRevision !== undefined && records.get(id)?.revision !== expectedRevision) throw new Error('version_mismatch');
            records.delete(id);
        },
    };
    const context = { artifacts, readSelection: () => selection,
        ...(initialPreference ? { readThemePreference: () => preference.value! } : {}),
        writeSelection: (mode: 'light' | 'dark', reference: ThemeReference | null, nextPreference?: ThemePreference) => {
            selection[mode] = reference;
            if (nextPreference !== undefined) preference.value = nextPreference;
            selectionPublications.push({ selection: { ...selection }, preference: preference.value });
        },
        createId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++generated).padStart(12, '0')}`, now: () => Date.parse('2026-11-16T12:00Z') };
    return { library: createThemeProfileLibrary(context), source: createThemeProfileSourceAdapter(context), records, selection, preference, selectionPublications, counts: () => ({ reads, writes, deletes, headerVisits }) };
}

describe('theme profile library', () => {
    it.each(['select', 'keep'] as const)('switches an explicit mode atomically through %s and restores both with Undo', async operation => {
        const state = setup(true, 'light');
        const theme = document(ids.first);
        const sibling = ref(ids.second);
        state.selection.light = sibling;
        await state.library.save({ document: theme });
        const applied = operation === 'select'
            ? await state.library.select({ mode: 'dark', reference: ref(ids.first) })
            : await state.library.keep({ mode: 'dark', document: theme });
        expect(state.selectionPublications).toEqual([
            { selection: { light: sibling, dark: ref(ids.first) }, preference: 'dark' },
        ]);
        await state.library.undo(applied.undo!);
        expect(state.selectionPublications).toEqual([
            { selection: { light: sibling, dark: ref(ids.first) }, preference: 'dark' },
            { selection: { light: sibling, dark: null }, preference: 'light' },
        ]);
    });

    it('switches and undoes the explicit mode when its theme slot was already selected', async () => {
        const state = setup(true, 'dark');
        await state.library.save({ document: document(ids.first) });
        state.selection.light = ref(ids.first);
        const applied = await state.library.select({ mode: 'light', reference: ref(ids.first) });
        expect(state.preference.value).toBe('light');
        expect(state.selectionPublications).toHaveLength(1);
        await state.library.undo(applied.undo!);
        expect(state.preference.value).toBe('dark');
        expect(state.selection.light).toEqual(ref(ids.first));
        expect(state.selectionPublications).toHaveLength(2);
    });

    it('keeps Adaptive while filling each slot and leaves later deliberate mode choices intact on Undo', async () => {
        const adaptive = setup(true, 'adaptive');
        const theme = document(ids.first);
        await adaptive.library.save({ document: theme });
        await adaptive.library.select({ mode: 'light', reference: ref(ids.first) });
        const kept = await adaptive.library.keep({ mode: 'dark', document: theme });
        expect(adaptive.selection).toEqual({ light: ref(ids.first), dark: ref(ids.first) });
        expect(adaptive.selectionPublications.map(row => row.preference)).toEqual(['adaptive', 'adaptive']);
        await adaptive.library.undo(kept.undo!);
        expect(adaptive.preference.value).toBe('adaptive');
        expect(adaptive.selection).toEqual({ light: ref(ids.first), dark: null });
        expect(adaptive.selectionPublications).toHaveLength(3);

        const explicit = setup(true, 'light');
        const applied = await explicit.library.keep({ mode: 'dark', document: theme });
        explicit.preference.value = 'adaptive';
        await explicit.library.undo(applied.undo!);
        expect(explicit.preference.value).toBe('adaptive');
        expect(explicit.selection.dark).toBeNull();
    });

    it('retains plugin miniatures across own-header changes and unchanged declarations', () => {
        const first = { pluginId: 'acme.themes', contributionId: 'first', theme: document('first').profile };
        const second = { pluginId: 'acme.themes', contributionId: 'second', theme: document('second').profile };
        const plugins = [first, second];
        const before = projectPluginThemeLibraryEntries(plugins);
        const own = projectThemeLibraryEntry(document('own'));
        const joined = projectThemeLibraryEntries([own], before, []);
        const changed = projectThemeLibraryEntry(document('own', { name: 'Renamed' }));
        const after = projectThemeLibraryEntries([changed], projectPluginThemeLibraryEntries(plugins), []);
        expect(after[0]).not.toBe(joined[0]);
        expect(after[1]).toBe(joined[1]);
        expect(after[2]).toBe(joined[2]);
        const pluginChange = projectPluginThemeLibraryEntries([{ ...first, theme: document('first', { name: 'Changed' }).profile }, second]);
        expect(pluginChange[0]).not.toBe(before[0]);
        expect(pluginChange[1]).toBe(before[1]);
        expect(pluginChange[1]?.miniature).toBe(before[1]?.miniature);
    });

    it('indexes Store faces once per operation and updates successful writes for retries', async () => {
        const state = setup();
        for (let i = 0; i < 200; i++) state.records.set(`theme-${i}`, { document: document(`theme-${i}`), revision: 1, headerVersion: 1 });
        const face = (id: string) => document(id, { source: { kind: 'store', provenance: provenance(), contributionId: id } });
        const first = await state.source.save(face('dark-face'));
        await state.source.save(face('light-face'));
        await state.source.save(face('dark-face'));
        expect(state.records.size).toBe(202);
        expect(state.counts().writes).toBe(2);
        expect(state.counts().headerVisits).toBeLessThanOrEqual(203);
        expect(first.entry?.source.kind).toBe('store');
    });

    it('lists forty CSS-heavy records without opening bodies and skips a no-op save', async () => {
        const state = setup();
        for (let i = 0; i < 40; i++) state.records.set(`theme-${i}`, { document: document(`theme-${i}`, { css: '.surface { color: red; }'.repeat(1000) }), revision: 1, headerVersion: 1 });
        expect((await state.library.list()).filter(entry => entry.source.kind === 'yours')).toHaveLength(40);
        expect(state.counts().reads).toBe(0);
        await state.library.save({ document: state.records.get('theme-0')!.document });
        expect(state.counts().writes).toBe(0);
    });

    it('addresses edits without replacing siblings and refuses source edits while allowing duplicates', async () => {
        const state = setup();
        await state.library.save({ document: document(ids.first) });
        await state.library.save({ document: document(ids.second) });
        const installed = await state.source.save(document('external', { source: { kind: 'store', provenance: provenance(), contributionId: 'dark' } }));
        expect((await state.source.list()).map(entry => entry.id)).toEqual([installed.entry!.id]);
        const stored = await state.library.get(installed.entry!.reference);
        await expect(state.library.save({ document: stored! })).rejects.toThrow();
        const copy = await state.library.duplicate({ reference: installed.entry!.reference });
        expect(copy.entry?.source.kind).toBe('yours');
        expect(state.records.has(ids.first)).toBe(true);
        expect(state.records.has(ids.second)).toBe(true);
        expect(state.records.size).toBe(4);
        await state.library.delete(ids.first);
        expect(state.records.has(ids.first)).toBe(false);
        expect(state.records.has(ids.second)).toBe(true);
        expect(state.records.has(installed.entry!.id)).toBe(true);
    });

    it('allocates a UUID for a new authored id and matches Store faces across updates', async () => {
        const state = setup();
        const own = await state.library.save({ document: document('external-id') });
        expect(own.entry?.id).toMatch(/^[a-f0-9-]{36}$/);
        const source = { kind: 'store', provenance: provenance(), contributionId: 'dark' };
        const first = await state.source.save(document('first', { source }));
        const writes = state.counts().writes;
        const unchanged = await state.source.save(document('first', { createdAt: '2026-11-17', updatedAt: '2026-11-17',
            source: { ...source, provenance: { ...provenance(), importedAt: 1 } } }));
        expect(unchanged.change.changedIds).toEqual([]);
        expect(state.counts().writes).toBe(writes);
        const second = await state.source.save(document('different', { source: { ...source, provenance: provenance(true) }, name: 'Updated' }));
        expect(second.entry?.reference).toEqual(first.entry?.reference);
        expect(state.records.size).toBe(2);
    });

    it('undoes only the kept revision, preserving siblings and later deliberate choices', async () => {
        const state = setup();
        const kept = await state.library.keep({ document: document(ids.kept), mode: 'dark' });
        await state.library.save({ document: document(ids.second) });
        state.selection.dark = ref(ids.second);
        await state.library.undo(kept.undo!);
        expect([...state.records.keys()]).toEqual([ids.second]);
        expect(state.selection.dark).toEqual(ref(ids.second));
    });

    it('accepts only the current opaque handle and never deletes on apply undo', async () => {
        const state = setup();
        const saved = await state.library.save({ document: document(ids.first) });
        expect(saved.undo).toBeUndefined();
        const applied = await state.library.select({ mode: 'dark', reference: ref(ids.first) });
        await expect(state.library.undo('forged')).rejects.toThrow();
        await state.library.undo(applied.undo!);
        expect(state.records.has(ids.first)).toBe(true);
        expect(state.counts().deletes).toBe(0);
        const predecessor = setup(false);
        await expect(predecessor.library.keep({ document: document(ids.first), mode: 'dark' })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
        expect(predecessor.records.has(ids.first)).toBe(true);
        expect(predecessor.selection.dark).toBeNull();
        expect(predecessor.library.lastUndo()).toBeNull();
        await expect(state.library.undo(applied.undo!)).rejects.toThrow();
        const kept = await state.library.keep({ document: document(ids.kept), mode: 'dark' });
        await state.library.save({ document: document(ids.kept, { name: 'Edited' }) });
        await expect(state.library.undo(kept.undo!)).rejects.toThrow('version_mismatch');
        expect(state.records.has(ids.kept)).toBe(true);
    });

    it('returns Undo for an already kept theme and repeated Apply without deleting the saved record', async () => {
        const state = setup();
        const authored = document(ids.first);
        await state.library.keep({ document: authored, mode: 'dark' });
        const keptAgain = await state.library.keep({ document: authored, mode: 'dark' });
        expect(keptAgain.undo).toEqual(expect.any(String));
        expect(keptAgain.change.selectionChangedModes).toEqual([]);
        await state.library.undo(keptAgain.undo!);
        expect(state.records.has(ids.first)).toBe(true);
        expect(state.selection.dark).toEqual(ref(ids.first));

        const appliedAgain = await state.library.select({ mode: 'dark', reference: ref(ids.first) });
        expect(appliedAgain.undo).toEqual(expect.any(String));
        expect(appliedAgain.change.selectionChangedModes).toEqual([]);
        await state.library.undo(appliedAgain.undo!);
        expect(state.selection.dark).toEqual(ref(ids.first));
        expect(state.counts().writes).toBe(1);
        expect(state.counts().deletes).toBe(0);
    });

    it('reports typed missing-theme and foreign or consumed Undo failures', async () => {
        const state = setup();
        await expect(state.library.duplicate({ reference: ref(ids.first) })).rejects.toMatchObject({ code: 'theme_not_found' });
        await expect(state.library.select({ mode: 'dark', reference: ref(ids.first) })).rejects.toMatchObject({ code: 'theme_not_found' });
        await expect(state.library.undo('foreign')).rejects.toMatchObject({ code: 'theme_undo_handle_unknown' });
        await state.library.save({ document: document(ids.first) });
        const applied = await state.library.select({ mode: 'dark', reference: ref(ids.first) });
        await state.library.undo(applied.undo!);
        await expect(state.library.undo(applied.undo!)).rejects.toMatchObject({ code: 'theme_undo_handle_unknown' });
        expect(state.selection.dark).toBeNull();
        expect(state.records.has(ids.first)).toBe(true);
    });

    it('retains future version and presentation through Keep, read and duplicate', async () => {
        const state = setup();
        const retained = document(ids.first, { schemaVersion: 2, style: { radius: 'round', futurePresentation: { glow: true } } });
        await state.library.keep({ document: retained, mode: 'dark' });
        const loaded = await state.library.get(ref(ids.first));
        expect(loaded?.raw.schemaVersion).toBe(2);
        expect(loaded?.raw.style).toEqual(retained.raw.style);
        const duplicate = await state.library.duplicate({ reference: ref(ids.first), name: 'Copy' });
        const copied = await state.library.get(duplicate.entry!.reference);
        expect(copied?.raw.schemaVersion).toBe(2);
        expect(copied?.raw.style).toEqual(retained.raw.style);
        expect(copied?.raw.name).toBe('Copy');
    });

    it('preserves authored timestamps and refuses to edit an existing theme through Keep', async () => {
        const state = setup();
        const imported = document(ids.first);
        await state.library.save({ document: imported });
        expect(state.records.get(ids.first)?.document.profile.updatedAt).toBe(imported.profile.updatedAt);
        const writes = state.counts().writes;
        await expect(state.library.keep({ document: document(ids.first, { name: 'Changed in preview' }), mode: 'dark' })).rejects.toThrow();
        expect(state.counts().writes).toBe(writes);
        expect(state.records.get(ids.first)?.document.profile.name).toBe(imported.profile.name);
        expect(state.selection.dark).toBeNull();
        const applied = await state.library.keep({ document: imported, mode: 'dark' });
        await state.library.undo(applied.undo!);
        expect(state.records.has(ids.first)).toBe(true);
        await state.library.save({ document: document(ids.first, { name: 'Edited' }) });
        expect(state.records.get(ids.first)?.document.profile.updatedAt).toBe('2026-11-16T12:00:00.000Z');
    });

    it('leaves missing tagged selections untouched and gives retired plugin references no accidental Artifact lookup', async () => {
        const state = setup();
        const plugin: ThemeReference = { kind: 'plugin', pluginId: 'local.theme', contributionId: 'night' };
        state.selection.dark = plugin;
        expect(await state.library.get(plugin)).toBeNull();
        expect(state.selection.dark).toBe(plugin);
        expect(state.counts().reads).toBe(0);
    });
});
