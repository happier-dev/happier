import { SavedSecretSchema as ProtocolSavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { z } from 'zod';

export const SavedSecretSchema = ProtocolSavedSecretSchema;

export type SavedSecret = z.infer<typeof SavedSecretSchema>;
