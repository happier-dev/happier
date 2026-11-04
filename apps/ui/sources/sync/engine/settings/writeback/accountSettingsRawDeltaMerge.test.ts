import { describe, expect, it } from 'vitest';

import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';
import { buildProfileSaveSettingsDelta } from '@/sync/domains/profiles/profileMutations';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';

import { mergePendingSettingsIntoRawBaseline } from './accountSettingsRawDeltaMerge';

function merge(rawBaseline: Record<string, unknown>, pendingSettings: Partial<Settings>) {
    return mergePendingSettingsIntoRawBaseline({
        rawBaseline, pendingSettings,
        normalizeForPersistedStorage: value => ({ value, changed: false }),
    }).outgoingRaw;
}

describe('account settings collection writeback', () => {
    it('preserves unreadable profiles and their pruned bindings across another profile save and deletion', () => {
        const visible = AIBackendProfileSchema.parse({ id: 'visible', name: 'Visible' });
        const unreadable = { id: 'unreadable', name: 'x'.repeat(101), futureField: { keep: true } };
        const bindings = { unreadable: { API_KEY: 'saved-secret' } };
        const raw = { profiles: [unreadable, visible, null], secretBindingsByProfileId: bindings };
        const view = settingsParse(raw);
        expect(view.profiles).toEqual([visible]);
        expect(view.secretBindingsByProfileId).toEqual({});

        const updated = { ...visible, name: 'Edited' };
        const saved = merge(raw, buildProfileSaveSettingsDelta({
            profiles: view.profiles,
            secretBindingsByProfileId: view.secretBindingsByProfileId,
            profile: updated, profileSecretBindings: {},
        }));
        expect(saved.profiles).toEqual([updated, unreadable, null]);
        expect(saved.secretBindingsByProfileId).toEqual(bindings);

        const deleted = merge(saved, { profiles: [], secretBindingsByProfileId: {} });
        expect(deleted.profiles).toEqual([unreadable, null]);
        expect(deleted.secretBindingsByProfileId).toEqual(bindings);
        expect(merge(deleted, { profiles: [], secretBindingsByProfileId: {} })).toEqual(deleted);
    });

    it.each([
        ['profiles', { id: 'future', name: 'Future', authMode: 'future-mode' }],
        ['secrets', { id: 'future', name: 'Future', kind: 'future-kind' }],
        ['executionRunsGuidanceEntries', { id: 'future', enabled: 'future-value' }],
    ])('preserves rejected %s entries without preventing deletion of readable entries', (key, unreadable) => {
        expect(merge({ [key]: [unreadable] }, { [key]: [] })[key]).toEqual([unreadable]);
    });

    it('preserves bindings to unreadable secrets, but allows deletion of the readable owning profile', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'visible', name: 'Visible', envVarRequirements: [{ name: 'API_KEY' }],
        });
        const secret = { id: 'future-secret', name: 'Future', kind: 'future-kind' };
        const bindings = { visible: { API_KEY: 'future-secret' } };
        const raw = { profiles: [profile], secrets: [secret], secretBindingsByProfileId: bindings };
        const view = settingsParse(raw);
        expect(view.secretBindingsByProfileId).toEqual({});
        const saved = merge(raw, { secrets: [], secretBindingsByProfileId: view.secretBindingsByProfileId });
        expect(saved.secrets).toEqual([secret]);
        expect(saved.secretBindingsByProfileId).toEqual(bindings);
        expect(merge(saved, { profiles: [], secretBindingsByProfileId: {} }).secretBindingsByProfileId).toEqual({});
    });

    it('refuses to replace an unreadable collection, while allowing unrelated settings edits', () => {
        const raw = { profiles: { futureFormat: true } };
        expect(() => merge(raw, { profiles: [] })).toThrow(/unreadable.*profiles/i);
        expect(merge(raw, { analyticsOptOut: true })).toEqual({ ...raw, analyticsOptOut: true });
    });

    it('rejects invalid new entries before they can be persisted', () => {
        const profile = { ...AIBackendProfileSchema.parse({ id: 'new', name: 'New' }), name: 'x'.repeat(101) };
        expect(() => merge({}, { profiles: [profile] })).toThrow(/invalid.*profiles/i);
    });

    it('refuses to overwrite an unreadable entry through an id collision', () => {
        const unreadable = { id: 'future', name: 'Future', authMode: 'future-mode' };
        const replacement = AIBackendProfileSchema.parse({ id: 'future', name: 'Replacement' });
        expect(() => merge({ profiles: [unreadable] }, { profiles: [replacement] })).toThrow(/unreadable.*profiles/i);
    });
});
