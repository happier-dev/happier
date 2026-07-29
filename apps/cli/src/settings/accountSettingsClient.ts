import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol';

function isAccountSettingsDebugEnabled(): boolean {
  const raw = typeof process.env.HAPPIER_DEBUG_ACCOUNT_SETTINGS === 'string'
    ? process.env.HAPPIER_DEBUG_ACCOUNT_SETTINGS.trim().toLowerCase()
    : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export async function decryptAccountSettingsCiphertext(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): Promise<Record<string, unknown> | null> {
  const { credentials, ciphertext } = params;
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material:
      credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: credentials.encryption.secret }
        : { type: 'dataKey', machineKey: credentials.encryption.machineKey },
    ciphertext,
  });
  if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: protocol open success', {
        encryptionType: credentials.encryption.type,
        format: opened.format,
        keyCount: Object.keys(opened.value as Record<string, unknown>).length,
      });
    }
    return opened.value as Record<string, unknown>;
  }

  // Historical untagged settings/templates shared the same raw key and carried
  // no authenticated domain. Admitting any raw object here would allow an
  // automation payload to be interpreted as account settings.
  return null;
}
