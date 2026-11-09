import { describe, expect, it } from 'vitest';
import type { ThemeProfileMigrationEdit, ThemeProfileV1 } from './themeProfileTypes';
import { applyThemeProfileMigrationEdits, mergeThemeProfileMigrationEdits, parseThemeProfileMigrationIntent, projectThemeProfileMigration, rebaseThemeProfileMigrationEdits, removeCommittedThemeProfileMigrationEdits } from './themeProfileMigrationEdits';

const profile: ThemeProfileV1 = { schemaVersion: 1, id: 'ocean', name: 'Ocean', createdAt: '2026-05-12', updatedAt: '2026-05-12', base: { light: 'light', dark: 'dark' }, overrides: { light: { 'future.token': '#ffffff' }, dark: {} } };
const edit: ThemeProfileMigrationEdit = { target: { kind: 'legacy', id: 'ocean' }, profile };

describe('pending theme migration intent', () => {
    it('admits current private checkpoints without changing optional profile fields or opaque overrides', () => {
        expect(parseThemeProfileMigrationIntent(undefined)).toBeNull();
        const intent = { edits: [edit], legacyProfileIds: { ocean: 'ocean_2' }, acknowledged: true as const, replaceLibrary: true as const };
        expect(parseThemeProfileMigrationIntent(intent)).toEqual(intent);
        expect(() => parseThemeProfileMigrationIntent({ ...intent, acknowledged: false })).toThrow();
        expect(() => parseThemeProfileMigrationIntent({ ...intent, edits: [{ ...edit, profile: { ...profile, overrides: { light: { bad: 'url(secret)' }, dark: {} } } }] })).toThrow();
    });

    it('retains later pending edits and rebases surviving edits to acknowledged identities', () => {
        const latest = { ...edit, profile: { ...profile, name: 'Latest' } };
        const merged = mergeThemeProfileMigrationEdits([edit], [latest]);
        expect(removeCommittedThemeProfileMigrationEdits(merged, [edit])).toEqual([latest]);
        const ids = new Map([['ocean', 'ocean_2']]);
        const rebased = rebaseThemeProfileMigrationEdits(merged, ids);
        expect(rebased[0].target).toEqual({ kind: 'account', id: 'ocean_2' });
        expect(applyThemeProfileMigrationEdits([], rebased, new Map())).toEqual([{ ...profile, id: 'ocean_2', name: 'Latest' }]);
        expect(() => rebaseThemeProfileMigrationEdits(merged, new Map())).toThrow();
    });
});

it('retains completion identities for consumed account edits and removes deleted targets', () => {
    const legacy = { profiles: [profile], activeProfileIds: { light: 'ocean', dark: null } };
    const edited = { ...profile, name: 'Edited' };
    const intent = { edits: [{ target: { kind: 'account' as const, id: 'ocean' }, profile: edited }], legacyProfileIds: { ocean: 'ocean' } };
    const projected = projectThemeProfileMigration([edited], legacy, intent);
    expect(projected.profiles).toEqual([edited]);
    expect(projected.legacy.profiles).toEqual([]);
    expect(Object.fromEntries(projected.legacyProfileIds)).toEqual({ ocean: 'ocean' });
    const deleted = projectThemeProfileMigration([], legacy, { ...intent, edits: [{ target: { kind: 'account', id: 'ocean' }, profile: null }] });
    expect(deleted.profiles).toEqual([]);
    expect(Object.fromEntries(deleted.legacyProfileIds)).toEqual({});
});

it('reads predecessor pending represented identities without reimporting their old backup definitions', () => {
    // Current 0.2 parser emits this optional private map, including an empty map.
    const serialized = JSON.stringify({ edits: [], legacyProfileIds: {}, representedLegacyProfileIds: { ocean: 'ocean' } });
    const intent = parseThemeProfileMigrationIntent(JSON.parse(serialized));
    const edited = { ...profile, name: 'Account edit after predecessor capture' };
    const legacy = { profiles: [profile], activeProfileIds: { light: 'ocean', dark: null } };
    const projected = projectThemeProfileMigration([edited], legacy, intent);
    expect(projected.profiles).toEqual([edited]);
    expect(projected.legacy.profiles).toEqual([]);
    expect(Object.fromEntries(projected.legacyProfileIds)).toEqual({ ocean: 'ocean' });
    expect(parseThemeProfileMigrationIntent({ edits: [], legacyProfileIds: {}, representedLegacyProfileIds: {} })).toEqual({ edits: [], legacyProfileIds: {}, representedLegacyProfileIds: {} });
});

it('reads predecessor attempted identities and reuses the accepted id after a lost reply and cloud deletion', () => {
    const legacy = { profiles: [profile], activeProfileIds: { light: 'ocean', dark: null } };
    const edited = { ...profile, name: 'Edited local' };
    // Captured before the initial GET: the displayed local id was still ocean.
    const captured = { edits: [{ target: { kind: 'legacy' as const, id: 'ocean' }, profile: edited }], legacyProfileIds: { ocean: 'ocean' } };
    const cloud = { ...profile, name: 'Cloud' };
    const first = projectThemeProfileMigration([cloud], legacy, captured);
    expect(first.profiles.map(value => value.id)).toEqual(['ocean', 'ocean_2']);
    // The POST succeeded but its reply was lost. Another device then deletes cloud ocean.
    const attempt = { ...captured, attemptedLegacyProfileIds: Object.fromEntries(first.legacyProfileIds) };
    const acceptedLocal = first.profiles.find(value => value.id === 'ocean_2')!;
    expect(projectThemeProfileMigration([acceptedLocal], legacy, attempt).profiles).toEqual([acceptedLocal]);
    const serialized = JSON.stringify(attempt);
    const predecessor = parseThemeProfileMigrationIntent(JSON.parse(serialized));
    const retry = projectThemeProfileMigration([acceptedLocal], legacy, predecessor);
    expect(retry.profiles).toEqual([acceptedLocal]);
    expect(Object.fromEntries(retry.legacyProfileIds)).toEqual({ ocean: 'ocean_2' });
    expect(() => parseThemeProfileMigrationIntent({ ...captured, attemptedLegacyProfileIds: { ocean: 'new' } })).toThrow();
});
