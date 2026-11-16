import { describe, expect, it } from 'vitest';
import { parseThemeProfileDocument, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createThemeProfileLibrary, type ThemeProfileArtifactAdapter } from './themeProfileLibrary';
import { projectThemeLibraryEntry } from './themeProfilePresentation';
import { createThemeTryOnOwner, type ThemeTryOnSnapshot } from './themeTryOn';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

const accountScope: AccountSettingsScope = { serverId: 'home', accountId: 'account' };

function document(id: string) {
    const parsed = parseThemeProfileDocument({ schemaVersion: 2, id, name: id,
        createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' },
        overrides: { light: {}, dark: {} }, style: { futurePresentation: { glow: true } } });
    if (!parsed.ok) throw new Error('Invalid fixture');
    return parsed.document;
}

function setup() {
    let scope: AccountSettingsScope | null = accountScope;
    const effectScopes: AccountSettingsScope[] = [];
    const rows = new Map<string, { document: ReturnType<typeof document>; revision: number; headerVersion: number }>();
    const selection = { light: null as ThemeReference | null, dark: null as ThemeReference | null };
    let beforeSave: (() => Promise<void>) | undefined;
    let writes = 0;
    const artifacts: ThemeProfileArtifactAdapter = {
        load: async () => {},
        list: () => [...rows.values()].map(row => ({ entry: projectThemeLibraryEntry(row.document), revision: row.revision, headerVersion: row.headerVersion })),
        get: async id => rows.get(id) ?? null,
        getSummary: async id => {
            const row = rows.get(id);
            return row ? { entry: projectThemeLibraryEntry(row.document), revision: row.revision, headerVersion: row.headerVersion } : null;
        },
        save: async value => {
            writes++;
            const barrier = beforeSave;
            beforeSave = undefined;
            await barrier?.();
            const row = { document: value, revision: 1, headerVersion: 1 };
            rows.set(value.profile.id, row);
            return { id: value.profile.id, ...row, created: true };
        },
        delete: async id => { rows.delete(id); },
    };
    const context = { artifacts, readSelection: () => selection,
        writeSelection: (mode: 'light' | 'dark', reference: ThemeReference | null) => { selection[mode] = reference; },
        createId: () => crypto.randomUUID(), now: () => Date.parse('2026-11-16T12:00Z') };
    const library = createThemeProfileLibrary(context);
    const callbacks = { captureScope: () => scope,
        keep: (input: Parameters<typeof library.keep>[0], captured: AccountSettingsScope) => { effectScopes.push(captured); return library.keep(input); },
        select: (input: Parameters<typeof library.select>[0], captured: AccountSettingsScope) => { effectScopes.push(captured); return library.select(input); },
        // Store acquisition/install is exercised by the Store lifecycle composition suite.
        installStore: async () => { throw new Error('Store origin is outside these agent/editor cases'); } };
    const owner = createThemeTryOnOwner(callbacks);
    return { owner, library, rows, selection, effectScopes, setScope: (next: AccountSettingsScope | null) => { scope = next; },
        writes: () => writes, holdSave: (barrier: () => Promise<void>) => { beforeSave = barrier; } };
}

describe('one-document theme try-on', () => {
    it('refuses a previous Account preview before any library effect and hides its overlay', async () => {
        const state = setup();
        const preview = state.owner.begin({ document: document('old_account'), mode: 'dark', origin: { kind: 'agent' } });
        state.setScope({ ...accountScope, accountId: 'other-account' });
        await expect(state.owner.keep(preview.previewRef)).rejects.toThrow('Artifact Account scope is unavailable');
        expect(state.owner.read()).toBeNull();
        expect(state.rows.size).toBe(0);
        expect(state.writes()).toBe(0);
        expect(state.selection).toEqual({ light: null, dark: null });
        expect(state.effectScopes).toEqual([]);
    });

    it('never assigns a preview captured without an Account to a later Account', async () => {
        const state = setup();
        const entry = (await state.library.list()).find(entry => entry.source.kind === 'built-in')!;
        await state.library.select({ reference: entry.reference, mode: 'dark' });
        state.setScope(null);
        const preview = state.owner.begin({ document: null, selection: null, mode: 'dark', origin: { kind: 'editor' } });
        state.setScope(accountScope);
        await expect(state.owner.keep(preview.previewRef)).rejects.toThrow('Artifact Account scope is unavailable');
        expect(state.owner.read()).toBeNull();
        expect(state.selection.dark).toEqual(entry.reference);
        expect(state.effectScopes).toEqual([]);
        expect(state.writes()).toBe(0);
    });

    it('passes captured scope to real library effects and captures a replacement independently', async () => {
        const state = setup();
        const first = state.owner.begin({ document: document('first_scope'), mode: 'dark', origin: { kind: 'editor' } });
        const replacementScope = { ...accountScope };
        state.setScope(replacementScope);
        const replacement = state.owner.replace(first.previewRef,
            { document: document('replacement_scope'), mode: 'dark', origin: { kind: 'editor' } });
        state.setScope({ ...replacementScope });
        expect(state.owner.read()).toBe(replacement);
        const saved = await state.owner.keep(replacement.previewRef);
        expect(state.effectScopes[0]).toBe(replacementScope);
        expect(state.rows.has(saved.entry!.id)).toBe(true);
        const base = state.owner.begin({ document: null, selection: null, mode: 'dark', origin: { kind: 'editor' } });
        await state.owner.keep(base.previewRef);
        expect(state.effectScopes).toEqual([replacementScope, replacementScope]);
        expect(state.selection.dark).toBeNull();
    });

    it('keeps an existing theme or the exact base by selecting without saving a body', async () => {
        const state = setup();
        const entry = (await state.library.list()).find(entry => entry.source.kind === 'built-in')!;
        const existing = state.owner.begin({ document: (await state.library.get(entry.reference))!,
            selection: entry.reference, mode: 'dark', origin: { kind: 'editor' } });
        await state.owner.keep(existing.previewRef);
        expect(state.selection.dark).toEqual(entry.reference);
        const base = state.owner.begin({ document: null, selection: null, mode: 'dark', origin: { kind: 'editor' } });
        expect(state.owner.read()?.document).toBeNull();
        await state.owner.keep(base.previewRef);
        expect(state.selection.dark).toBeNull();
        expect(state.writes()).toBe(0);
        expect(state.rows.size).toBe(0);
    });
    it('replaces one overlay, refuses stale cards and publishes no writes while trying or reverting', async () => {
        const state = setup();
        const observed: (ThemeTryOnSnapshot | null)[] = [];
        const stop = state.owner.subscribe(() => observed.push(state.owner.read()));
        const first = state.owner.begin({ document: document('first'), mode: 'dark', origin: { kind: 'agent' } });
        const replacement = state.owner.replace(first.previewRef, { document: document('replacement'), mode: 'light', origin: { kind: 'editor' } });
        expect(() => state.owner.revert(first.previewRef)).toThrowError(expect.objectContaining({ code: 'theme_preview_stale' }));
        await expect(state.owner.keep(first.previewRef)).rejects.toMatchObject({ code: 'theme_preview_stale' });
        expect(state.owner.read()).toBe(replacement);
        state.owner.revert(replacement.previewRef);
        expect(state.owner.read()).toBeNull();
        expect(observed).toEqual([first, replacement, null]);
        expect(state.writes()).toBe(0);
        expect(state.selection).toEqual({ light: null, dark: null });
        stop();
        state.owner.begin({ document: document('after-unsubscribe'), mode: 'dark', origin: { kind: 'agent' } });
        expect(observed).toHaveLength(3);
    });

    it('shares an admitted Keep and preserves a replacement when its Artifact save settles', async () => {
        const state = setup();
        let release!: () => void;
        let started!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const saving = new Promise<void>(resolve => { started = resolve; });
        state.holdSave(async () => { started(); await pending; });
        const first = state.owner.begin({ document: document('kept'), mode: 'dark', origin: { kind: 'agent' } });
        const keep = state.owner.keep(first.previewRef);
        const sameKeep = state.owner.keep(first.previewRef);
        await saving;
        state.setScope({ ...accountScope, accountId: 'replacement-account' });
        const replacement = state.owner.begin({ document: document('new-preview'), mode: 'dark', origin: { kind: 'agent' } });
        release();
        const [result, repeated] = await Promise.all([keep, sameKeep]);
        expect(repeated).toEqual(result);
        expect(state.writes()).toBe(1);
        expect(state.effectScopes).toEqual([accountScope]);
        expect(state.owner.read()).toBe(replacement);
        expect(state.rows.get(result.entry!.id)?.document.raw.style).toEqual({ futurePresentation: { glow: true } });
    });

    it('keeps a failed save preview available for an explicit retry', async () => {
        const state = setup();
        const preview = state.owner.begin({ document: document('retry'), mode: 'light', origin: { kind: 'editor' } });
        state.holdSave(async () => { throw new Error('network unavailable'); });
        await expect(state.owner.keep(preview.previewRef)).rejects.toThrow('network unavailable');
        expect(state.owner.read()).toBe(preview);
        const result = await state.owner.keep(preview.previewRef);
        expect(result.entry).not.toBeNull();
        expect(state.owner.read()).toBeNull();
        expect(state.writes()).toBe(2);
    });
});
