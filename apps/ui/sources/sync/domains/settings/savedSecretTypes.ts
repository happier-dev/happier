import { SavedSecretSchema as ProtocolSavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { z } from 'zod';
import type { SavedSecretImportSourceV1, SavedSecretLegacyChatCredentialV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

export const SavedSecretSchema = ProtocolSavedSecretSchema;

export type SavedSecret = z.infer<typeof SavedSecretSchema>;

/** Transient import/cleanup facts; usable resource material has its own admission. */
export type SavedSecretVerifiedImportReference = Readonly<{
    source: SavedSecretImportSourceV1 | Extract<SavedSecretLegacyChatCredentialV1['source'], { kind: 'existing-resource-reference' }>;
    resourceRef: string;
    revision: number;
}>;
export type SavedSecretLegacyImportResult =
    | Readonly<{ status: 'complete'; verifiedReferences?: readonly SavedSecretVerifiedImportReference[];
        /** Present for a caller-pinned source only after exact own ACK/readback. */
        sourceSettingsVersion?: number }>
    | Readonly<{ status: 'pending'; reason: 'source-unavailable' | 'source-uncharacterized' | 'changed' | 'outcome_unknown' | 'history-pending' }>;
