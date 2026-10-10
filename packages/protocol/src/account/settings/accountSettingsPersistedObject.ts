import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The opaque persisted Account Settings document carried by the storage and
 * encryption envelopes. This deliberately does not apply Account Settings
 * defaults: readers that need effective settings use accountSettingsParse.
 *
 * Keeping this leaf separate prevents envelope/action contracts from loading
 * the full effective-settings catalog during module initialization.
 */
export const AccountSettingsPersistedObjectSchema = lazyZodSchema(() => z.object({}).passthrough());
export type AccountSettingsPersistedObject = z.infer<typeof AccountSettingsPersistedObjectSchema>;
