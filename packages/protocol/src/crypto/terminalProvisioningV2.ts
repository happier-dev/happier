import { openBoxBundle, sealBoxBundle } from './boxBundle.js';

export const TERMINAL_PROVISIONING_V2_VERSION_BYTE = 0;
export const TERMINAL_PROVISIONING_V2_CONTENT_PRIVATE_KEY_BYTES = 32;
export const TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES =
  1 + TERMINAL_PROVISIONING_V2_CONTENT_PRIVATE_KEY_BYTES;

export function sealTerminalProvisioningV2Payload(params: {
  contentPrivateKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}): Uint8Array {
  if (params.contentPrivateKey.length !== TERMINAL_PROVISIONING_V2_CONTENT_PRIVATE_KEY_BYTES) {
    throw new Error(`Invalid content private key length: ${params.contentPrivateKey.length}`);
  }

  const plaintext = new Uint8Array(TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES);
  plaintext[0] = TERMINAL_PROVISIONING_V2_VERSION_BYTE;
  plaintext.set(params.contentPrivateKey, 1);

  return sealBoxBundle({
    plaintext,
    recipientPublicKey: params.recipientPublicKey,
    randomBytes: params.randomBytes,
  });
}

export function openTerminalProvisioningV2Payload(params: {
  payload: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
}): Uint8Array | null {
  const opened = openBoxBundle({
    bundle: params.payload,
    recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed,
  });
  if (!opened) return null;
  if (opened.length !== TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES) return null;
  if (opened[0] !== TERMINAL_PROVISIONING_V2_VERSION_BYTE) return null;

  return opened.slice(1);
}

