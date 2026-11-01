import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const AccountSettingsPersistedObjectSchema = lazySchema(() => z.object({}).passthrough());

export type AccountSettingsPersistedObject = z.infer<typeof AccountSettingsPersistedObjectSchema>;
