import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt } from '@/api/encryption';
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

  const key =
    credentials.encryption.type === 'legacy'
      ? credentials.encryption.secret
      : credentials.encryption.machineKey;
  const variant = credentials.encryption.type === 'legacy' ? 'legacy' : 'dataKey';

  try {
    const decoded = decodeBase64(ciphertext);
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: start', {
        encryptionType: credentials.encryption.type,
        variant,
        decodedLength: decoded.length,
        firstByte: decoded.length ? decoded[0] : null,
        looksLikeAesV0: decoded.length ? decoded[0] === 0 : null,
      });
    }
    const decrypted = decrypt(key, variant, decoded) as unknown;
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: success', {
        encryptionType: credentials.encryption.type,
        variant,
        keyCount: Object.keys(decrypted as Record<string, unknown>).length,
      });
    }
    return decrypted as Record<string, unknown>;
  } catch {
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: threw', {
        encryptionType: credentials.encryption.type,
        variant,
      });
    }
    return null;
  }
}
