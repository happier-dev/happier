import { describe, expect, it } from 'vitest';
import { createThemeProfileMigrationEdits, createThemeProfileNavigationParams, rebaseThemeProfileUiChange, rememberThemeProfileMigration, resolveAccountThemeProfileView, resolveThemeProfileNavigationId } from './themeProfiles';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

const profile = (id: string, name = id): ThemeProfileV1 => ({
    schemaVersion: 1, id, name, createdAt: '2026-10-01', updatedAt: '2026-10-01',
    base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} },
});
const scope = { serverId: 'server', accountId: 'account' };
const empty = { profiles: [], activeProfileIds: { light: null, dark: null } };

describe('account theme profile view', () => {
    it('does not resurrect an acknowledged legacy profile from its cleanup backup', () => {
        const view = resolveAccountThemeProfileView({ profiles: [profile('same', 'Cloud')],
            legacy: { ...empty, profiles: [profile('same', 'Legacy')] }, legacyScope: scope, scope,
            selection: { light: null, dark: { legacyProfileId: 'same' } },
            pendingProfiles: [profile('same', 'Cloud')],
            pendingIntent: { acknowledged: true, edits: [], legacyProfileIds: { same: 'same_2' } } });
        expect(view.state.profiles).toEqual([profile('same', 'Cloud')]);
        expect(view.state.activeProfileIds.dark).toBeNull();
        expect(view.legacyProfileIds.size).toBe(0);
    });

    it('exposes deleted account selections as inactive while retaining built-in selections', () => {
        const view = resolveAccountThemeProfileView({ profiles: [], legacy: empty, legacyScope: null, scope,
            selection: { light: 'premiumLight', dark: 'deleted' } });
        expect(view.state.activeProfileIds).toEqual({ light: 'premiumLight', dark: null });
    });

    it('rebases a captured legacy draft using the acknowledged collision identity and preserves arriving profiles', () => {
        const draftScope = { ...scope, accountId: 'draft' };
        const before = resolveAccountThemeProfileView({ profiles: [], legacy: { ...empty, profiles: [profile('same', 'Legacy')] },
            selection: null, legacyScope: null, scope: draftScope });
        const route = createThemeProfileNavigationParams(before, 'same');
        rememberThemeProfileMigration(draftScope, new Map([['same', 'same_2']]));
        const current = resolveAccountThemeProfileView({ profiles: [profile('same', 'Cloud'), profile('same_2', 'Legacy'), profile('arrived')],
            legacy: empty, selection: null, legacyScope: draftScope, scope: draftScope });
        const next = rebaseThemeProfileUiChange(before, { ...before.state, profiles: [profile('same', 'Edited draft')],
            activeProfileIds: { light: null, dark: 'same' } }, current);
        expect(next.profiles).toEqual([profile('same', 'Cloud'), profile('same_2', 'Edited draft'), profile('arrived')]);
        expect(next.activeProfileIds.dark).toBe('same_2');
        expect(resolveThemeProfileNavigationId(current, route.profileId, route.themeProfileIdentity ?? null)).toBe('same_2');
    });

    it('refuses an old legacy draft without a proven migration identity', () => {
        const draftScope = { ...scope, accountId: 'unproven' };
        const before = resolveAccountThemeProfileView({ profiles: [], legacy: { ...empty, profiles: [profile('same', 'Legacy')] },
            selection: null, legacyScope: null, scope: draftScope });
        const current = resolveAccountThemeProfileView({ profiles: [profile('same', 'Cloud')], legacy: empty,
            selection: null, legacyScope: draftScope, scope: draftScope });
        expect(() => rebaseThemeProfileUiChange(before, { ...before.state, profiles: [profile('same', 'Edited draft')] }, current)).toThrow();
        const route = createThemeProfileNavigationParams(before, 'same');
        expect(resolveThemeProfileNavigationId(current, route.profileId, route.themeProfileIdentity ?? null)).toBeNull();
    });

    it('does not clear a newer selection when deleting the previously active profile', () => {
        const before = resolveAccountThemeProfileView({ profiles: [profile('delete-me')], legacy: empty, legacyScope: null, scope,
            selection: { light: null, dark: 'delete-me' } });
        const current = resolveAccountThemeProfileView({ profiles: [profile('delete-me'), profile('arrived')], legacy: empty,
            legacyScope: null, scope, selection: { light: null, dark: 'arrived' } });
        const next = rebaseThemeProfileUiChange(before, { profiles: [], activeProfileIds: { light: null, dark: null } }, current);
        expect(next.profiles).toEqual([profile('arrived')]);
        expect(next.activeProfileIds.dark).toBe('arrived');
    });

    it('edits an already represented legacy profile as the existing account row', () => {
        const same = profile('same');
        const before = resolveAccountThemeProfileView({ profiles: [same], legacy: { ...empty, profiles: [same] },
            scope, legacyScope: null, selection: null });
        const edits = createThemeProfileMigrationEdits(before.state, { ...before.state, profiles: [profile('same', 'Edited')] },
            before.legacyProfileIds);
        expect(edits).toEqual([{ target: { kind: 'account', id: 'same' }, profile: profile('same', 'Edited') }]);
    });
});
