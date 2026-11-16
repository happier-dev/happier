import { parseThemeProfileDocument, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createThemeProfileLibrary, type ThemeProfileArtifactAdapter } from '@/theme/profiles/themeProfileLibrary';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { createThemeTryOnOwner } from '@/theme/profiles/themeTryOn';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

export function themeActionDocument(id: string) {
    const parsed = parseThemeProfileDocument({ schemaVersion: 2, id, name: id,
        createdAt: '2026-11-16', updatedAt: '2026-11-16', base: { light: 'light', dark: 'dark' },
        overrides: { light: {}, dark: {} }, style: { futurePresentation: { glow: true } } });
    if (!parsed.ok) throw new Error('Invalid fixture');
    return parsed.document;
}

/** Real library and preview owners with only their Artifact persistence boundary in memory. */
export function createThemeActionHarness() {
    const rows = new Map<string, { document: ReturnType<typeof themeActionDocument>; revision: number; headerVersion: number }>();
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
    const context = { artifacts, undoState: { current: null }, readSelection: () => selection,
        writeSelection: (mode: 'light' | 'dark', reference: ThemeReference | null) => { selection[mode] = reference; },
        createId: () => crypto.randomUUID(), now: () => Date.parse('2026-11-16T12:00Z') };
    const library = createThemeProfileLibrary(context);
    const accountScope: AccountSettingsScope = Object.freeze({ serverId: 'theme-test-home', accountId: 'theme-test-account' });
    const owner = createThemeTryOnOwner({ captureScope: () => accountScope,
        keep: input => library.keep(input), select: input => library.select(input),
        // Store acquisition/install is exercised by the Store lifecycle composition suite.
        installStore: async () => { throw new Error('Store origin is outside these agent/editor cases'); } });
    return { owner, library, context, rows, selection, writes: () => writes, holdSave: (barrier: () => Promise<void>) => { beforeSave = barrier; } };
}
