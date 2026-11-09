import { describe, expect, it } from 'vitest';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { encodeThemeProfileSelection, resolveAccountThemeProfiles, resolveAccountThemeProfilesSnapshot } from './themeProfiles';

const legacy = { profiles: [], activeProfileIds: { light: 'paperLight', dark: 'premiumDark' } };
describe('account theme library composition', () => {
    it('uses allowed legacy activation until a local selection has been chosen', () => {
        expect(resolveAccountThemeProfiles({ profiles: [], legacy, selection: null, legacyScope: null, scope: null }).activeProfileIds).toEqual(legacy.activeProfileIds);
    });
});


const profile: ThemeProfileV1 = { schemaVersion: 1, id: 'theme_ocean', name: 'Account', createdAt: '2026-05-12', updatedAt: '2026-05-12', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } };
it('keeps explicit canonical selection while remapping the unmigrated legacy selection', () => {
    const input = { profiles: [profile], legacy: { profiles: [{ ...profile, name: 'Device' }], activeProfileIds: { light: 'theme_ocean', dark: null } }, legacyScope: null, scope: null };
    const migrated = resolveAccountThemeProfiles({ ...input, selection: null });
    expect(migrated.activeProfileIds.light).toBe('theme_ocean_2');
    expect(resolveAccountThemeProfiles({ ...input, selection: { light: 'theme_ocean', dark: null } }).activeProfileIds.light).toBe('theme_ocean');
});

it('follows a selected legacy origin when its id collides with a later account profile', () => {
    const input = { profiles: [profile], legacy: { profiles: [{ ...profile, name: 'Device' }], activeProfileIds: { light: null, dark: null } }, legacyScope: null, scope: null };
    const selection = { light: { legacyProfileId: 'theme_ocean' }, dark: null };
    expect(resolveAccountThemeProfiles({ ...input, selection }).activeProfileIds.light).toBe('theme_ocean_2');
});

it('encodes only selections originating in the displayed legacy library', () => {
    const local = { profiles: [{ ...profile, name: 'Device' }], activeProfileIds: { light: 'theme_ocean', dark: null } };
    const selectedBeforeAccountRead = encodeThemeProfileSelection([], local, local.activeProfileIds);
    expect(selectedBeforeAccountRead.light).toEqual({ legacyProfileId: 'theme_ocean' });
    expect(resolveAccountThemeProfiles({ profiles: [profile], legacy: local, selection: selectedBeforeAccountRead, legacyScope: null, scope: null }).activeProfileIds.light).toBe('theme_ocean_2');
    expect(encodeThemeProfileSelection([profile], local, local.activeProfileIds).light).toBe('theme_ocean');
});

it('captures legacy row origins once while keeping account-owned deduplicated rows canonical', () => {
    const shared = { ...profile, id: 'theme_shared', name: 'Shared' };
    const local = {
        profiles: [{ ...profile, name: 'Device' }, shared, { ...profile, id: 'theme_solo', name: 'Local only' }],
        activeProfileIds: { light: 'theme_ocean', dark: null },
    };
    const input = { profiles: [profile, shared], legacy: local, selection: null, legacyScope: null, scope: null };
    const snapshot = resolveAccountThemeProfilesSnapshot(input);
    expect(snapshot.themeProfiles.profiles).toHaveLength(4);
    expect(snapshot.legacyProfileIds).toEqual({ theme_ocean_2: 'theme_ocean', theme_solo: 'theme_solo' });
    const blocked = resolveAccountThemeProfilesSnapshot({
        ...input,
        legacyScope: { serverId: 'home', accountId: 'other' },
        scope: { serverId: 'home', accountId: 'current' },
    });
    expect(blocked.legacyProfileIds).toEqual({});
    expect(blocked.themeProfiles.profiles).toEqual(input.profiles);
});

it('clears only the effective selection when a custom profile disappears and restores it if the profile returns', () => {
    const selection = { light: 'theme_deleted', dark: 'premiumDark' };
    const input = { profiles: [], legacy: { profiles: [], activeProfileIds: { light: null, dark: null } }, selection, legacyScope: null, scope: null };
    expect(resolveAccountThemeProfiles(input).activeProfileIds).toEqual({ light: null, dark: 'premiumDark' });
    expect(selection.light).toBe('theme_deleted');
    expect(resolveAccountThemeProfiles({ ...input, profiles: [{ ...profile, id: 'theme_deleted' }] }).activeProfileIds.light).toBe('theme_deleted');
});

it('projects pending legacy edits before merging so a lost acknowledgement cannot resurrect old backup rows', () => {
    const device = { ...profile, name: 'Device' };
    const edited = { ...device, id: 'theme_ocean_2', name: 'Edited' };
    const input = { profiles: [profile, edited], legacy: { profiles: [device], activeProfileIds: { light: 'theme_ocean', dark: 'premiumDark' } }, selection: { light: { legacyProfileId: 'theme_ocean' }, dark: null }, legacyScope: null, scope: null,
        pendingIntent: { edits: [{ target: { kind: 'legacy' as const, id: 'theme_ocean' }, profile: edited }], legacyProfileIds: { theme_ocean: 'theme_ocean_2' } } };
    const result = resolveAccountThemeProfilesSnapshot(input);
    expect(result.themeProfiles.profiles).toEqual([profile, edited]);
    expect(result.themeProfiles.activeProfileIds.light).toBe('theme_ocean_2');
    const deleted = resolveAccountThemeProfilesSnapshot({ ...input, profiles: [profile], pendingIntent: { ...input.pendingIntent, edits: [{ target: { kind: 'legacy' as const, id: 'theme_ocean' }, profile: null }] } });
    expect(deleted.themeProfiles.profiles).toEqual([profile]);
    expect(deleted.themeProfiles.activeProfileIds.light).toBeNull();
});

it('uses acknowledged and replacement checkpoints without importing the retired backup', () => {
    const input = { profiles: [profile], legacy: { profiles: [{ ...profile, name: 'Old device' }], activeProfileIds: { light: 'theme_ocean', dark: 'premiumDark' } }, selection: null, legacyScope: null, scope: null,
        pendingProfiles: [], pendingIntent: { edits: [], legacyProfileIds: {}, acknowledged: true as const } };
    expect(resolveAccountThemeProfilesSnapshot(input)).toEqual({ themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: 'premiumDark' } }, legacyProfileIds: {} });
    expect(resolveAccountThemeProfiles({ ...input, pendingIntent: { edits: [], legacyProfileIds: {}, replaceLibrary: true as const } }).profiles).toEqual([]);
});

it('consumes account-owned backup rows and reuses a proven collision identity after the original slot is deleted', () => {
    const device = { ...profile, name: 'Device' };
    const edited = { ...profile, name: 'Edited account' };
    const base = { legacy: { profiles: [device], activeProfileIds: { light: null, dark: null } }, selection: null, legacyScope: null, scope: null };
    expect(resolveAccountThemeProfiles({ ...base, profiles: [edited], pendingIntent: { edits: [{ target: { kind: 'account' as const, id: profile.id }, profile: edited }], legacyProfileIds: { theme_ocean: 'theme_ocean' } } }).profiles).toEqual([edited]);
    const promoted = { ...device, id: 'theme_ocean_2' };
    expect(resolveAccountThemeProfiles({ ...base, profiles: [promoted], pendingIntent: { edits: [{ target: { kind: 'account' as const, id: profile.id }, profile: null }], legacyProfileIds: { theme_ocean: 'theme_ocean_2' } } }).profiles).toEqual([promoted]);
});

it('lets a later account edit supersede an earlier legacy edit at the captured identity', () => {
    const device = { ...profile, name: 'Device' };
    const first = { ...device, id: 'theme_ocean_2', name: 'First edit' };
    const latest = { ...first, name: 'Latest edit' };
    const input = { profiles: [profile, latest], legacy: { profiles: [device], activeProfileIds: { light: null, dark: null } }, selection: null, legacyScope: null, scope: null,
        pendingIntent: { edits: [{ target: { kind: 'legacy' as const, id: 'theme_ocean' }, profile: first }, { target: { kind: 'account' as const, id: 'theme_ocean_2' }, profile: latest }], legacyProfileIds: { theme_ocean: 'theme_ocean_2' } } };
    expect(resolveAccountThemeProfilesSnapshot(input)).toEqual({ themeProfiles: { profiles: [profile, latest], activeProfileIds: { light: null, dark: null } }, legacyProfileIds: {} });
});
