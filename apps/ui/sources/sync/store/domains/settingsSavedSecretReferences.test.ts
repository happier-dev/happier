import { describe, expect, it } from 'vitest';
import { AccountSettingsSavedSecretMutationError, listAccountSettingsSavedSecretReferences } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

import { projectSavedSecretReferenceSettings } from './settingsSavedSecretReferences';

describe('settings reference fact publication', () => {
    it('does not revisit unchanged carriers for preference changes and keeps future carrier additions and removals', () => {
        let visits = 0;
        const future = { get secretRef() { visits++; return 'referenced'; } };
        const settings = { future, themePreference: 'dark' };
        const references = projectSavedSecretReferenceSettings(settings);
        visits = 0;
        const changedPreference = { ...settings, themePreference: 'light' };
        expect(projectSavedSecretReferenceSettings(changedPreference, settings, references)).toBe(references);
        expect(visits).toBe(0);

        const changedCarrier = { ...changedPreference, future: { bootstrapCredentialRef: 'other' } };
        const next = projectSavedSecretReferenceSettings(changedCarrier, changedPreference, references);
        expect(next).not.toBe(references);
        expect(listAccountSettingsSavedSecretReferences(next, 'other')).toEqual([
            { owner: 'unknown', path: 'future.bootstrapCredentialRef' },
        ]);
        expect(projectSavedSecretReferenceSettings({ themePreference: 'light' }, changedCarrier, next)).toEqual({});
    });

    it('publishes known bindings and retains invalid known roots for the census to refuse', () => {
        const previous = { secretBindingsByProfileId: { work: { TOKEN: 'one' } } };
        const references = projectSavedSecretReferenceSettings(previous);
        const changed = { secretBindingsByProfileId: { work: { TOKEN: 'two' } }, providerSettingsV1: 'invalid-root' };
        const next = projectSavedSecretReferenceSettings(changed, previous, references);
        expect(next).toEqual(changed);
        expect(() => listAccountSettingsSavedSecretReferences(next, 'two')).toThrow(AccountSettingsSavedSecretMutationError);
        expect(listAccountSettingsSavedSecretReferences({ secretBindingsByProfileId: changed.secretBindingsByProfileId }, 'two'))
            .toMatchObject([{ owner: 'profile', referrer: { id: 'work' } }]);
    });
});
