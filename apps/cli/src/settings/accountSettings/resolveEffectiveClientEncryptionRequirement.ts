import { combineClientEncryptionRequirements, isAccountEncryptionModeAllowedByClientRequirement, isSessionEncryptionModeAllowedByClientRequirement } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';
import type { AccountSettings, ClientEncryptionRequirement, SessionEncryptionMode } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { getActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';

export function resolveEffectiveClientEncryptionRequirement(
  settings: AccountSettings | null = getActiveAccountSettingsSnapshot()?.settings ?? null,
): ClientEncryptionRequirement {
  return combineClientEncryptionRequirements(
    configuration.clientEncryptionRequirement,
    settings?.clientEncryptionRequirementV1 ?? 'follow_account',
  );
}

export function assertAccountEncryptionModeAllowedByEffectiveClientRequirement(
  mode: 'e2ee' | 'plain',
  settings: AccountSettings,
): void {
  if (isAccountEncryptionModeAllowedByClientRequirement(
    resolveEffectiveClientEncryptionRequirement(settings),
    mode,
  )) return;
  throw Object.assign(
    new Error('This Happier client requires end-to-end encryption, but the Account settings are stored as plaintext.'),
    { code: 'CLIENT_E2EE_REQUIRED', retryable: false },
  );
}

export function isSessionEncryptionModeAllowedByEffectiveClientRequirement(
  mode: SessionEncryptionMode,
): boolean {
  return isSessionEncryptionModeAllowedByClientRequirement(
    resolveEffectiveClientEncryptionRequirement(),
    mode,
  );
}

export function assertSessionEncryptionModeAllowedByEffectiveClientRequirement(
  mode: SessionEncryptionMode,
): void {
  if (isSessionEncryptionModeAllowedByEffectiveClientRequirement(mode)) return;
  throw Object.assign(
    new Error('This Happier client requires end-to-end encryption, but the server or Account selected plaintext storage.'),
    { code: 'CLIENT_E2EE_REQUIRED', retryable: false },
  );
}

export function isClientE2eeRequiredError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'CLIENT_E2EE_REQUIRED',
  );
}
