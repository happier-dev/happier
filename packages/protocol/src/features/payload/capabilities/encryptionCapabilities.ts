import { z } from 'zod';

export const EncryptionStoragePolicySchema = z.enum(['required_e2ee', 'optional', 'plaintext_only']);
export type EncryptionStoragePolicy = z.infer<typeof EncryptionStoragePolicySchema>;

export const AccountEncryptionModeSchema = z.enum(['e2ee', 'plain']);
export type AccountEncryptionMode = z.infer<typeof AccountEncryptionModeSchema>;

export const EncryptionCapabilitiesSchema = z.object({
  storagePolicy: EncryptionStoragePolicySchema,
  allowAccountOptOut: z.boolean(),
  defaultAccountMode: AccountEncryptionModeSchema,
});

export type EncryptionCapabilities = z.infer<typeof EncryptionCapabilitiesSchema>;

export const DEFAULT_ENCRYPTION_CAPABILITIES: EncryptionCapabilities = {
  storagePolicy: 'required_e2ee',
  allowAccountOptOut: false,
  defaultAccountMode: 'e2ee',
};

