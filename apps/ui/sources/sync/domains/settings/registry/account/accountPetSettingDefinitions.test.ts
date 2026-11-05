import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

describe('Protocol pet Account settings', () => {
    it('defaults account pets to disabled Blink with overlay default enabled', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.petsEnabled.default).toBe(false);
        expect(ACCOUNT_SETTING_DEFINITIONS.petsSelectedPetRef.default).toEqual({
            kind: 'builtIn',
            petId: 'blink',
        });
        expect(ACCOUNT_SETTING_DEFINITIONS.petsDesktopOverlayDefaultEnabled.default).toBe(true);
        expect(ACCOUNT_SETTING_DEFINITIONS).not.toHaveProperty('petsDesktopOverlayDefaultVisibilityMode');
    });

    it('strips retired pet activity mode without changing Account enable or selection preferences', () => {
        const parsed = accountSettingsParse({ petsDesktopOverlayDefaultVisibilityMode: 'attentionOnly', petsEnabled: true,
            petsDesktopOverlayDefaultEnabled: false, petsSelectedPetRef: { kind: 'accountPet', accountPetId: 'chosen-pet' },
            futurePreference: { retained: true } });
        expect(parsed).not.toHaveProperty('petsDesktopOverlayDefaultVisibilityMode');
        expect(parsed).toMatchObject({ petsEnabled: true, petsDesktopOverlayDefaultEnabled: false,
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: 'chosen-pet' }, futurePreference: { retained: true } });
    });

    it('allows only built-in and account-pet references in account settings', () => {
        const definition = ACCOUNT_SETTING_DEFINITIONS.petsSelectedPetRef;
        const { parseMutationValue } = definition;

        expect(parseMutationValue({ kind: 'builtIn', petId: 'blink' }).success).toBe(true);
        expect(parseMutationValue({ kind: 'accountPet', accountPetId: 'acct_pet_1' }).success).toBe(true);
        for (const value of [
            { kind: 'detectedCodexHome', sourceKey: 'codex:local' },
            { kind: 'happierManagedLocal', sourceKey: 'local:blink' },
        ]) {
            expect(parseMutationValue(value).success).toBe(false);
            expect(definition.schema.parse(value)).toEqual({ kind: 'builtIn', petId: 'blink' });
        }
    });
});
