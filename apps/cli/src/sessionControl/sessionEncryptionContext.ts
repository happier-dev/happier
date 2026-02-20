import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { openSessionDataEncryptionKey } from '@/api/client/openSessionDataEncryptionKey';

export type SessionEncryptionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

export type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export function resolveSessionStoredContentEncryptionMode(rawSession?: Readonly<{ encryptionMode?: unknown }>): SessionStoredContentEncryptionMode {
  return rawSession && (rawSession as any).encryptionMode === 'plain' ? 'plain' : 'e2ee';
}

export function resolveSessionEncryptionContextFromCredentials(
  credentials: Credentials,
  rawSession?: Readonly<{ dataEncryptionKey?: unknown }>,
): SessionEncryptionContext {
  if (credentials.encryption.type === 'legacy') {
    return { encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy' };
  }

  const encryptedDekBase64 =
    typeof rawSession?.dataEncryptionKey === 'string' ? String(rawSession.dataEncryptionKey).trim() : '';

  // Prefer the session's published DEK, but allow machineKey fallback for older sessions.
  const opened = openSessionDataEncryptionKey({
    credential: credentials,
    encryptedDataEncryptionKeyBase64: encryptedDekBase64 || null,
  });

  return { encryptionKey: opened ?? credentials.encryption.machineKey, encryptionVariant: 'dataKey' };
}

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function tryDecryptSessionMetadata(params: Readonly<{
  credentials: Credentials;
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
}>): Record<string, unknown> | null {
  const encryptedMetadataBase64 =
    typeof params.rawSession.metadata === 'string' ? String(params.rawSession.metadata).trim() : '';
  if (!encryptedMetadataBase64) return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'plain') {
    return tryParseJsonRecord(encryptedMetadataBase64);
  }

  const { encryptionKey, encryptionVariant } = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );

  try {
    const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedMetadataBase64, 'base64'));
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    return decrypted as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function encryptStoredSessionPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  payload: unknown;
}>): string {
  if (params.mode === 'plain') {
    return JSON.stringify(params.payload);
  }
  return encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload), 'base64');
}

export function decryptStoredSessionPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  value: string;
}>): unknown {
  const raw = params.value.trim();
  if (params.mode === 'plain') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(raw, 'base64'),
  );
}

export function encryptSessionPayload(params: Readonly<{
  ctx: SessionEncryptionContext;
  payload: unknown;
}>): string {
  return encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, params.payload), 'base64');
}

export function decryptSessionPayload(params: Readonly<{
  ctx: SessionEncryptionContext;
  ciphertextBase64: string;
}>): unknown {
  return decrypt(
    params.ctx.encryptionKey,
    params.ctx.encryptionVariant,
    decodeBase64(params.ciphertextBase64, 'base64'),
  );
}
