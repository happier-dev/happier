import type { Credentials, StoredCredentials } from '@/persistence';

export const ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE_ERROR_CODE =
  'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' as const;

export class AccountSettingsEncryptionMaterialUnavailableError extends Error {
  readonly code = ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE_ERROR_CODE;

  constructor(
    message = 'Account settings are encrypted and require account encryption material on this device.',
  ) {
    super(message);
    this.name = 'AccountSettingsEncryptionMaterialUnavailableError';
  }
}

export function requireAccountSettingsEncryptionCredentials(
  credentials: StoredCredentials,
): Credentials {
  if (!credentials.encryption) {
    throw new AccountSettingsEncryptionMaterialUnavailableError();
  }
  return credentials;
}

export function isAccountSettingsEncryptionMaterialUnavailableError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE_ERROR_CODE,
  );
}
