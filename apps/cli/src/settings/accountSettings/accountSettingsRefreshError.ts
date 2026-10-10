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

/** A fetched/cached value was available, but its authoritative settings schema rejected it. */
export class AccountSettingsContentInvalidError extends Error {
  readonly code = 'ACCOUNT_SETTINGS_CONTENT_INVALID';

  constructor(cause: unknown) {
    super('Account settings content is invalid.', { cause });
    this.name = 'AccountSettingsContentInvalidError';
  }
}

export function isAccountSettingsContentInvalidError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ACCOUNT_SETTINGS_CONTENT_INVALID',
  );
}
