import { defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

export const AccountPetReferenceSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('builtIn'),
        petId: z.string().min(1),
    }),
    z.object({
        kind: z.literal('accountPet'),
        accountPetId: z.string().min(1),
    }),
]);

export const AccountPetDesktopOverlayVisibilityModeSchema = z.enum([
    'attentionOrActive',
    'alwaysWhenEnabled',
    'attentionOnly',
]);

export const ACCOUNT_PET_SETTING_DEFINITIONS = defineSettingDefinitions({
    petsEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable Happier pet companions for the account',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    petsSelectedPetRef: {
        schema: AccountPetReferenceSchema,
        default: { kind: 'builtIn', petId: 'blink' },
        description: 'Account default pet source reference',
        storageScope: 'account',
    },
    petsDesktopOverlayDefaultEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Default desktop companion overlay setting for the account',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    petsDesktopOverlayDefaultVisibilityMode: {
        schema: AccountPetDesktopOverlayVisibilityModeSchema,
        default: 'alwaysWhenEnabled',
        description: 'Default desktop companion overlay visibility mode',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
});
