import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';

import {
  publishPrivateBearerFileIfAbsent,
  readPrivateBearerFile,
} from './privateBearerFile';

const DEVICE_LOCAL_KEY_BYTES = 32;
const DEVICE_LOCAL_NONCE_BYTES = 12;
const DEVICE_LOCAL_AUTH_TAG_BYTES = 16;
const DEVICE_LOCAL_CIPHERTEXT_PREFIX = 'v1';

export type DeviceLocalSecretPurpose = 'session_respawn_environment';
export type DeviceLocalOpaqueIdentityPurpose =
  'external_session_transcript_refresh_cursor';
export type DeviceLocalDerivedSecretKeyPurpose =
  | 'memory_settings_secrets'
  | 'plugin_secrets'
  | 'npm_registry_credentials';

export type DeviceLocalSecretStorage = Readonly<{
  sealJson: (input: Readonly<{
    purpose: DeviceLocalSecretPurpose;
    value: unknown;
    randomBytes?: (length: number) => Uint8Array;
  }>) => string;
  openJson: (input: Readonly<{
    purpose: DeviceLocalSecretPurpose;
    ciphertext: string;
  }>) => unknown | null;
  deriveOpaqueIdentity: (input: Readonly<{
    purpose: DeviceLocalOpaqueIdentityPurpose;
    value: string;
  }>) => string;
  deriveSecretKey: (input: Readonly<{
    purpose: DeviceLocalDerivedSecretKeyPurpose;
  }>) => Uint8Array;
}>;

function parseKeyFile(raw: string, path: string): Buffer {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected object');
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2
      || record.version !== 1
      || typeof record.key !== 'string'
    ) {
      throw new Error('unexpected shape');
    }
    const key = Buffer.from(record.key, 'base64url');
    if (key.byteLength !== DEVICE_LOCAL_KEY_BYTES) {
      throw new Error('unexpected key length');
    }
    return key;
  } catch (error) {
    throw new Error(
      `Invalid device-local secret key at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function serializeKeyFile(key: Uint8Array): string {
  return JSON.stringify({
    version: 1,
    key: Buffer.from(key).toString('base64url'),
  });
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function aadForPurpose(purpose: DeviceLocalSecretPurpose): Buffer {
  return Buffer.from(`happier.device-local-secret:${DEVICE_LOCAL_CIPHERTEXT_PREFIX}:${purpose}`, 'utf8');
}

function opaqueIdentityDomain(
  purpose: DeviceLocalOpaqueIdentityPurpose,
): string {
  return `happier.device-local-secret:opaque:v1:${purpose}`;
}

function derivedSecretKeyDomain(
  purpose: DeviceLocalDerivedSecretKeyPurpose,
): string {
  return `happier.device-local-secret:derived-key:v1:${purpose}`;
}

function createStorage(key: Buffer): DeviceLocalSecretStorage {
  return Object.freeze({
    sealJson: (input) => {
      const nonceBytes = (input.randomBytes ?? nodeRandomBytes)(DEVICE_LOCAL_NONCE_BYTES);
      if (nonceBytes.byteLength !== DEVICE_LOCAL_NONCE_BYTES) {
        throw new Error('Device-local secret nonce source returned an invalid length');
      }
      const nonce = Buffer.from(nonceBytes);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aadForPurpose(input.purpose));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(input.value), 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return [
        DEVICE_LOCAL_CIPHERTEXT_PREFIX,
        nonce.toString('base64url'),
        ciphertext.toString('base64url'),
        authTag.toString('base64url'),
      ].join('.');
    },
    openJson: (input) => {
      try {
        const parts = input.ciphertext.split('.');
        if (parts.length !== 4 || parts[0] !== DEVICE_LOCAL_CIPHERTEXT_PREFIX) {
          return null;
        }
        const nonce = Buffer.from(parts[1]!, 'base64url');
        const ciphertext = Buffer.from(parts[2]!, 'base64url');
        const authTag = Buffer.from(parts[3]!, 'base64url');
        if (
          nonce.byteLength !== DEVICE_LOCAL_NONCE_BYTES
          || authTag.byteLength !== DEVICE_LOCAL_AUTH_TAG_BYTES
        ) {
          return null;
        }
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aadForPurpose(input.purpose));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf8');
        return JSON.parse(plaintext) as unknown;
      } catch {
        return null;
      }
    },
    deriveOpaqueIdentity: (input) =>
      createHmac('sha256', key)
        .update(opaqueIdentityDomain(input.purpose), 'utf8')
        .update('\0', 'utf8')
        .update(input.value, 'utf8')
        .digest('hex'),
    deriveSecretKey: (input) =>
      new Uint8Array(
        createHmac('sha256', key)
          .update(derivedSecretKeyDomain(input.purpose), 'utf8')
          .digest(),
      ),
  });
}

export async function readOrCreateDeviceLocalSecretStorage(input: Readonly<{
  path: string;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<DeviceLocalSecretStorage> {
  try {
    return createStorage(parseKeyFile(await readPrivateBearerFile(input.path), input.path));
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  const key = (input.randomBytes ?? nodeRandomBytes)(DEVICE_LOCAL_KEY_BYTES);
  if (key.byteLength !== DEVICE_LOCAL_KEY_BYTES) {
    throw new Error('Device-local secret key source returned an invalid length');
  }
  const published = await publishPrivateBearerFileIfAbsent({
    path: input.path,
    contents: serializeKeyFile(key),
  });
  const storedKey = published
    ? Buffer.from(key)
    : parseKeyFile(await readPrivateBearerFile(input.path), input.path);
  return createStorage(storedKey);
}
