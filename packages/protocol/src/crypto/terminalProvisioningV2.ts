import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

import { openBoxBundle, sealBoxBundle } from './boxBundle.js';
import { encodeCanonicalLengthDelimited } from './canonicalDigest.js';

export const TERMINAL_PROVISIONING_V2_VERSION_BYTE = 0;
export const TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG = 1;
export const TERMINAL_PROVISIONING_V2_CONTENT_PRIVATE_KEY_BYTES = 32;
export const TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES =
  1 + TERMINAL_PROVISIONING_V2_CONTENT_PRIVATE_KEY_BYTES;
export const TERMINAL_PROVISIONING_V2_TOKEN_ONLY_PLAINTEXT_BYTES = 1;

export type TerminalProvisioningV2Response =
  | Readonly<{ type: 'dataKey'; key: Uint8Array }>
  | Readonly<{ type: 'tokenOnly' }>;

const TERMINAL_PROVISIONING_V3_MAGIC = new Uint8Array([0x48, 0x50, 0x56, 0x33]);
const TERMINAL_PROVISIONING_V3_MAC_BYTES = 32;
const TERMINAL_PROVISIONING_BOX_OVERHEAD_BYTES = 32 + 24 + 16;
const TERMINAL_PROVISIONING_V3_SEALED_V2_DATA_KEY_BYTES =
  TERMINAL_PROVISIONING_BOX_OVERHEAD_BYTES + TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES;
const TERMINAL_PROVISIONING_V3_SEALED_V2_TOKEN_ONLY_BYTES =
  TERMINAL_PROVISIONING_BOX_OVERHEAD_BYTES + TERMINAL_PROVISIONING_V2_TOKEN_ONLY_PLAINTEXT_BYTES;
const TERMINAL_PROVISIONING_V3_DATA_KEY_PAYLOAD_BYTES =
  TERMINAL_PROVISIONING_V3_MAGIC.length
  + TERMINAL_PROVISIONING_V3_SEALED_V2_DATA_KEY_BYTES
  + TERMINAL_PROVISIONING_V3_MAC_BYTES;
const TERMINAL_PROVISIONING_V3_TOKEN_ONLY_PAYLOAD_BYTES =
  TERMINAL_PROVISIONING_V3_MAGIC.length
  + TERMINAL_PROVISIONING_V3_SEALED_V2_TOKEN_ONLY_BYTES
  + TERMINAL_PROVISIONING_V3_MAC_BYTES;
const TERMINAL_PROVISIONING_V3_MAC_DOMAIN = 'happier-terminal-provisioning-v3';

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

export function sealTerminalProvisioningV2TokenOnlyPayload(params: {
  recipientPublicKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}): Uint8Array {
  return sealBoxBundle({
    plaintext: new Uint8Array([TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG]),
    recipientPublicKey: params.recipientPublicKey,
    randomBytes: params.randomBytes,
  });
}

export function parseTerminalProvisioningV2Plaintext(
  plaintext: Uint8Array,
): TerminalProvisioningV2Response | null {
  if (
    plaintext.length === TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES
    && plaintext[0] === TERMINAL_PROVISIONING_V2_VERSION_BYTE
  ) {
    return { type: 'dataKey', key: plaintext.slice(1) };
  }
  if (
    plaintext.length === TERMINAL_PROVISIONING_V2_TOKEN_ONLY_PLAINTEXT_BYTES
    && plaintext[0] === TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG
  ) {
    return { type: 'tokenOnly' };
  }
  return null;
}

export function openTerminalProvisioningV2Response(params: {
  payload: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
}): TerminalProvisioningV2Response | null {
  const opened = openBoxBundle({
    bundle: params.payload,
    recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed,
  });
  return opened ? parseTerminalProvisioningV2Plaintext(opened) : null;
}

export function openTerminalProvisioningV2Payload(params: {
  payload: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
}): Uint8Array | null {
  const opened = openTerminalProvisioningV2Response(params);
  return opened?.type === 'dataKey' ? opened.key : null;
}

function assertTerminalProvisioningV3Context(params: {
  terminalEphemeralPublicKey: Uint8Array;
  pairingSecret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
}): void {
  if (params.terminalEphemeralPublicKey.length !== 32) {
    throw new Error(`Invalid terminal ephemeral public key length: ${params.terminalEphemeralPublicKey.length}`);
  }
  if (params.pairingSecret.length !== 32) {
    throw new Error(`Invalid pairing secret length: ${params.pairingSecret.length}`);
  }
  if (
    !Number.isSafeInteger(params.createdAtMs)
    || !Number.isSafeInteger(params.expiresAtMs)
    || params.createdAtMs < 0
    || params.expiresAtMs <= params.createdAtMs
  ) {
    throw new Error('Invalid terminal provisioning validity window');
  }
}

function computeTerminalProvisioningV3Mac(params: {
  pairingSecret: Uint8Array;
  terminalEphemeralPublicKey: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  sealedV2Payload: Uint8Array;
}): Uint8Array {
  return hmac(
    sha256,
    params.pairingSecret,
    encodeCanonicalLengthDelimited([
      TERMINAL_PROVISIONING_V3_MAC_DOMAIN,
      params.terminalEphemeralPublicKey,
      String(params.createdAtMs),
      String(params.expiresAtMs),
      params.sealedV2Payload,
    ]),
  );
}

function equalBytesConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function isTerminalProvisioningV3Payload(payload: Uint8Array): boolean {
  if (
    payload.length !== TERMINAL_PROVISIONING_V3_DATA_KEY_PAYLOAD_BYTES
    && payload.length !== TERMINAL_PROVISIONING_V3_TOKEN_ONLY_PAYLOAD_BYTES
  ) {
    return false;
  }
  return TERMINAL_PROVISIONING_V3_MAGIC.every((byte, index) => payload[index] === byte);
}

function sealTerminalProvisioningV3Response(params: {
  sealedV2Payload: Uint8Array;
  terminalEphemeralPublicKey: Uint8Array;
  pairingSecret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
}): Uint8Array {
  assertTerminalProvisioningV3Context(params);
  const sealedV2Payload = params.sealedV2Payload;
  if (
    sealedV2Payload.length !== TERMINAL_PROVISIONING_V3_SEALED_V2_DATA_KEY_BYTES
    && sealedV2Payload.length !== TERMINAL_PROVISIONING_V3_SEALED_V2_TOKEN_ONLY_BYTES
  ) {
    throw new Error('Invalid terminal provisioning v2 response length');
  }
  const mac = computeTerminalProvisioningV3Mac({ ...params, sealedV2Payload });
  const payload = new Uint8Array(
    TERMINAL_PROVISIONING_V3_MAGIC.length + sealedV2Payload.length + TERMINAL_PROVISIONING_V3_MAC_BYTES,
  );
  payload.set(TERMINAL_PROVISIONING_V3_MAGIC, 0);
  payload.set(sealedV2Payload, TERMINAL_PROVISIONING_V3_MAGIC.length);
  payload.set(mac, TERMINAL_PROVISIONING_V3_MAGIC.length + sealedV2Payload.length);
  return payload;
}

export function sealTerminalProvisioningV3Payload(params: {
  contentPrivateKey: Uint8Array;
  terminalEphemeralPublicKey: Uint8Array;
  pairingSecret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  randomBytes: (length: number) => Uint8Array;
}): Uint8Array {
  return sealTerminalProvisioningV3Response({
    ...params,
    sealedV2Payload: sealTerminalProvisioningV2Payload({
      contentPrivateKey: params.contentPrivateKey,
      recipientPublicKey: params.terminalEphemeralPublicKey,
      randomBytes: params.randomBytes,
    }),
  });
}

export function sealTerminalProvisioningV3TokenOnlyPayload(params: {
  terminalEphemeralPublicKey: Uint8Array;
  pairingSecret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  randomBytes: (length: number) => Uint8Array;
}): Uint8Array {
  return sealTerminalProvisioningV3Response({
    ...params,
    sealedV2Payload: sealTerminalProvisioningV2TokenOnlyPayload({
      recipientPublicKey: params.terminalEphemeralPublicKey,
      randomBytes: params.randomBytes,
    }),
  });
}

export function openTerminalProvisioningV3Response(params: {
  payload: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
  terminalEphemeralPublicKey: Uint8Array;
  pairingSecret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  nowMs: number;
}): TerminalProvisioningV2Response | null {
  try {
    assertTerminalProvisioningV3Context(params);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(params.nowMs) || params.nowMs < params.createdAtMs || params.nowMs > params.expiresAtMs) {
    return null;
  }
  if (!isTerminalProvisioningV3Payload(params.payload)) return null;

  const sealedPayloadStart = TERMINAL_PROVISIONING_V3_MAGIC.length;
  const macStart = params.payload.length - TERMINAL_PROVISIONING_V3_MAC_BYTES;
  const sealedV2Payload = params.payload.slice(sealedPayloadStart, macStart);
  const receivedMac = params.payload.slice(macStart);
  const expectedMac = computeTerminalProvisioningV3Mac({ ...params, sealedV2Payload });
  if (!equalBytesConstantTime(receivedMac, expectedMac)) return null;

  return openTerminalProvisioningV2Response({
    payload: sealedV2Payload,
    recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed,
  });
}

export function openTerminalProvisioningV3Payload(params: {
  payload: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
  terminalEphemeralPublicKey: Uint8Array;
  pairingSecret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  nowMs: number;
}): Uint8Array | null {
  const opened = openTerminalProvisioningV3Response(params);
  return opened?.type === 'dataKey' ? opened.key : null;
}
