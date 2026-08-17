import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol';

describe('Protocol pet Account settings', () => {
    it('defaults account pets to disabled Blink with overlay default enabled', () => {
        expect(ACCOUNT_SETTING_DEFINITIONS.petsEnabled.default).toBe(false);
        expect(ACCOUNT_SETTING_DEFINITIONS.petsSelectedPetRef.default).toEqual({
            kind: 'builtIn',
            petId: 'blink',
        });
        expect(ACCOUNT_SETTING_DEFINITIONS.petsDesktopOverlayDefaultEnabled.default).toBe(true);
        expect(ACCOUNT_SETTING_DEFINITIONS.petsDesktopOverlayDefaultVisibilityMode.default).toBe('alwaysWhenEnabled');
    });

    it('allows only built-in and account-pet references in account settings', () => {
        const schema = ACCOUNT_SETTING_DEFINITIONS.petsSelectedPetRef.schema;

        expect(schema.safeParse({ kind: 'builtIn', petId: 'blink' }).success).toBe(true);
        expect(schema.safeParse({ kind: 'accountPet', accountPetId: 'acct_pet_1' }).success).toBe(true);
        expect(schema.safeParse({ kind: 'detectedCodexHome', sourceKey: 'codex:local' }).success).toBe(false);
        expect(schema.safeParse({ kind: 'happierManagedLocal', sourceKey: 'local:blink' }).success).toBe(false);
    });
});
