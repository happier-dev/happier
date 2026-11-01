import { z } from 'zod';
import { lazySchema } from '../../../lazySchema.js';

export const EncryptionStoragePolicySchema = lazySchema(() => z.enum(['required_e2ee', 'optional', 'plaintext_only']));
export type EncryptionStoragePolicy = z.infer<typeof EncryptionStoragePolicySchema>;

export const AccountEncryptionModeSchema = lazySchema(() => z.enum(['e2ee', 'plain']));
export type AccountEncryptionMode = z.infer<typeof AccountEncryptionModeSchema>;

export const PlainAccountAtRestPolicySchema = lazySchema(() => z.enum(['none', 'server_sealed']));
export type PlainAccountAtRestPolicy = z.infer<typeof PlainAccountAtRestPolicySchema>;

export const EncryptionCapabilitiesSchema = lazySchema(() => z.object({
  storagePolicy: EncryptionStoragePolicySchema,
  allowAccountOptOut: z.boolean(),
  defaultAccountMode: AccountEncryptionModeSchema,
  plainAccountSettingsAtRest: PlainAccountAtRestPolicySchema.optional().default('server_sealed'),
  plainAccountCredentialsAtRest: PlainAccountAtRestPolicySchema.optional().default('server_sealed'),
}));

export type EncryptionCapabilities = z.infer<typeof EncryptionCapabilitiesSchema>;

export const DEFAULT_ENCRYPTION_CAPABILITIES: EncryptionCapabilities = {
  storagePolicy: 'required_e2ee',
  allowAccountOptOut: false,
  defaultAccountMode: 'e2ee',
  plainAccountSettingsAtRest: 'server_sealed',
  plainAccountCredentialsAtRest: 'server_sealed',
};
