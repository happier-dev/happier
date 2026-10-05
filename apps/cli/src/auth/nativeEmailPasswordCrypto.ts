import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

import {
  PasswordEnvelopeKdfV1Schema,
  PasswordWrappedRecoverySecretV1Schema,
  PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1,
  PASSWORD_ENVELOPE_NONCE_BYTES_V1,
  PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
  acceptPasswordTextV1,
  createPasswordEnvelopeAadV1,
  decodePasswordCredentialFieldV1,
  deriveAccountMachineKeyFromRecoverySecret,
  encodePasswordCredentialFieldV1,
  signAccountContentKeyBindingV1,
  type PasswordEnvelopeKdfV1,
  type PasswordWrappedRecoverySecretV1,
} from '@happier-dev/protocol';

import { openAes256GcmBytes, sealAes256GcmBytes } from '@happier-dev/transfers/node';
import { deriveKey } from '@/utils/deriveKey';

type PasswordSodium = Readonly<{
  ready: Promise<unknown>;
  libsodium: { useBackupModule: () => never };
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_pwhash: (
    length: number,
    password: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimitBytes: number,
    algorithm: number,
  ) => Uint8Array;
}>;

const sodiumModule: unknown = createRequire(import.meta.url)('libsodium-wrappers-sumo');

async function loadPasswordSodium(): Promise<PasswordSodium> {
  if (
    !sodiumModule
    || typeof sodiumModule !== 'object'
    || !('ready' in sodiumModule)
    || !(sodiumModule.ready instanceof Promise)
    || !('libsodium' in sodiumModule)
    || !sodiumModule.libsodium
    || typeof sodiumModule.libsodium !== 'object'
    || !('useBackupModule' in sodiumModule.libsodium)
    || typeof sodiumModule.libsodium.useBackupModule !== 'function'
  ) {
    throw new Error('password_kdf_unavailable');
  }
  sodiumModule.libsodium.useBackupModule = () => {
    throw new Error('password_kdf_unavailable');
  };
  await sodiumModule.ready;
  if (
    !('crypto_pwhash' in sodiumModule)
    || typeof sodiumModule.crypto_pwhash !== 'function'
    || !('crypto_pwhash_ALG_ARGON2ID13' in sodiumModule)
    || sodiumModule.crypto_pwhash_ALG_ARGON2ID13 !== 2
  ) {
    throw new Error('password_kdf_unavailable');
  }
  return sodiumModule as PasswordSodium;
}

function abortError(): Error {
  const error = new Error('Password authentication cancelled');
  error.name = 'AbortError';
  return error;
}

function assertCurrent(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export async function deriveNativeEmailPasswordKeys(input: Readonly<{
  password: string;
  kdf: PasswordEnvelopeKdfV1;
  signal?: AbortSignal;
}>): Promise<Readonly<{ wrapKey: Uint8Array; authKey: Uint8Array }>> {
  const kdf = PasswordEnvelopeKdfV1Schema.parse(input.kdf);
  const accepted = acceptPasswordTextV1(input.password);
  if (!accepted.accepted) throw new Error('password_text_rejected');
  let root: Uint8Array | undefined;
  let wrapKey: Uint8Array | undefined;
  let authKey: Uint8Array | undefined;
  try {
    assertCurrent(input.signal);
    const sodium = await loadPasswordSodium();
    assertCurrent(input.signal);
    root = sodium.crypto_pwhash(
      kdf.outputBytes,
      accepted.utf8,
      decodePasswordCredentialFieldV1(kdf.salt),
      kdf.opsLimit,
      kdf.memLimitBytes,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    assertCurrent(input.signal);
    wrapKey = await deriveKey(root, 'Happier Password Envelope', ['v1', 'wrap']);
    authKey = await deriveKey(root, 'Happier Password Envelope', ['v1', 'auth']);
    return { wrapKey, authKey };
  } catch (error) {
    wrapKey?.fill(0);
    authKey?.fill(0);
    throw error;
  } finally {
    accepted.utf8.fill(0);
    root?.fill(0);
  }
}

export function openNativeEmailPasswordEnvelope(
  envelopeInput: unknown,
  wrapKey: Uint8Array,
): Uint8Array {
  let secret: Uint8Array | undefined;
  try {
    const envelope = PasswordWrappedRecoverySecretV1Schema.parse(envelopeInput);
    secret = openAes256GcmBytes({
      key: wrapKey,
      nonce: decodePasswordCredentialFieldV1(envelope.cipher.nonce),
      aad: createPasswordEnvelopeAadV1(envelope),
      ciphertext: decodePasswordCredentialFieldV1(envelope.cipher.ciphertext),
    });
    if (
      secret.byteLength !== 32
      || encodePasswordCredentialFieldV1(tweetnacl.sign.keyPair.fromSeed(secret).publicKey)
        !== envelope.accountSigningPublicKey
    ) {
      throw new Error('password_authentication_failed');
    }
    return secret;
  } catch {
    secret?.fill(0);
    throw new Error('password_authentication_failed');
  }
}

export function passwordEnvelopeKdfsEqual(
  left: PasswordEnvelopeKdfV1,
  right: PasswordEnvelopeKdfV1,
): boolean {
  return left.algorithm === right.algorithm
    && left.salt === right.salt
    && left.opsLimit === right.opsLimit
    && left.memLimitBytes === right.memLimitBytes
    && left.outputBytes === right.outputBytes;
}

export async function prepareNativeEmailPasswordCredential(input: Readonly<{
  password: string;
  secret: Uint8Array;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  authKey: string;
  envelope: PasswordWrappedRecoverySecretV1;
  contentPublicKey: string;
  contentPublicKeySig: string;
}>> {
  if (input.secret.byteLength !== 32) throw new Error('password_envelope_secret_invalid');
  const kdf = PasswordEnvelopeKdfV1Schema.parse({
    ...PASSWORD_ENVELOPE_WRITER_PROFILE_V1,
    salt: encodePasswordCredentialFieldV1(randomBytes(PASSWORD_ENVELOPE_KDF_SALT_BYTES_V1)),
  });
  const keys = await deriveNativeEmailPasswordKeys({
    password: input.password,
    kdf,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const nonce = new Uint8Array(randomBytes(PASSWORD_ENVELOPE_NONCE_BYTES_V1));
  const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(input.secret);
  const contentPrivateKey = deriveAccountMachineKeyFromRecoverySecret(input.secret);
  try {
    assertCurrent(input.signal);
    const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(contentPrivateKey).publicKey;
    const header = {
      v: 1 as const,
      accountSigningPublicKey: encodePasswordCredentialFieldV1(signingKeyPair.publicKey),
      kdf,
      cipher: {
        algorithm: 'aes256gcm' as const,
        nonce: encodePasswordCredentialFieldV1(nonce),
      },
    };
    const ciphertext = sealAes256GcmBytes({
      key: keys.wrapKey,
      nonce,
      aad: createPasswordEnvelopeAadV1(header),
      plaintext: input.secret,
    });
    const envelope = PasswordWrappedRecoverySecretV1Schema.parse({
      ...header,
      cipher: {
        ...header.cipher,
        ciphertext: encodePasswordCredentialFieldV1(ciphertext),
      },
    });
    const contentPublicKeySig = signAccountContentKeyBindingV1({
      accountSigningSecretKey: signingKeyPair.secretKey,
      contentPublicKey,
    });
    assertCurrent(input.signal);
    return {
      authKey: encodePasswordCredentialFieldV1(keys.authKey),
      envelope,
      contentPublicKey: encodePasswordCredentialFieldV1(contentPublicKey),
      contentPublicKeySig: encodePasswordCredentialFieldV1(contentPublicKeySig),
    };
  } finally {
    keys.authKey.fill(0);
    keys.wrapKey.fill(0);
    nonce.fill(0);
    signingKeyPair.secretKey.fill(0);
    contentPrivateKey.fill(0);
  }
}
