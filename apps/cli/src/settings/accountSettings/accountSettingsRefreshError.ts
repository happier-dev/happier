export const ACCOUNT_SETTINGS_STALE_ERROR_CODE = 'ACCOUNT_SETTINGS_STALE' as const;

export class AccountSettingsStaleError extends Error {
  readonly code = ACCOUNT_SETTINGS_STALE_ERROR_CODE;

  constructor(message = 'Account settings are still syncing. Please retry once settings finish syncing.') {
    super(message);
    this.name = 'AccountSettingsStaleError';
  }
}

export function isAccountSettingsStaleError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === ACCOUNT_SETTINGS_STALE_ERROR_CODE,
  );
}
