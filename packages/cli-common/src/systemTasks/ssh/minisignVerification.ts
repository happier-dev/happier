import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';

const ED25519_ALGORITHM = new Uint8Array([0x45, 0x64]);
const ED25519_PREHASH_ALGORITHM = new Uint8Array([0x45, 0x44]);

export const DEFAULT_MINISIGN_PUBLIC_KEY = `untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
`;

function decodeBase64(value: string, expectedBytes?: number): Uint8Array {
  const input = String(value ?? '').trim();
  const binary = typeof globalThis.atob === 'function'
    ? globalThis.atob(input)
    : Buffer.from(input, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (expectedBytes != null && bytes.length !== expectedBytes) {
    throw new Error(`[minisign] expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function parsePublicKey(pubkeyFile: string): Readonly<{
  signatureAlgorithm: Uint8Array;
  keyId: Uint8Array;
  rawPublicKey: Uint8Array;
}> {
  const lines = String(pubkeyFile ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error('[minisign] invalid public key file');
  }
  const bytes = decodeBase64(lines[lines.length - 1] ?? '', 42);
  return {
    signatureAlgorithm: bytes.subarray(0, 2),
    keyId: bytes.subarray(2, 10),
    rawPublicKey: bytes.subarray(10, 42),
  };
}

function parseSignature(sigFile: string): Readonly<{
  signatureAlgorithm: Uint8Array;
  keyId: Uint8Array;
  signature: Uint8Array;
  trustedSuffix: Uint8Array;
  globalSignature: Uint8Array;
}> {
  const lines = String(sigFile ?? '').split('\n');
  if (lines.length < 4) {
    throw new Error('[minisign] invalid signature file');
  }
  const untrustedBytes = decodeBase64(String(lines[1] ?? ''), 74);
  const trustedComment = String(lines[2] ?? '');
  if (!trustedComment.startsWith('trusted comment: ')) {
    throw new Error('[minisign] unexpected trusted comment format');
  }
  return {
    signatureAlgorithm: untrustedBytes.subarray(0, 2),
    keyId: untrustedBytes.subarray(2, 10),
    signature: untrustedBytes.subarray(10, 74),
    trustedSuffix: utf8(trustedComment.slice('trusted comment: '.length)),
    globalSignature: decodeBase64(String(lines[3] ?? ''), 64),
  };
}

export function verifyMinisign(params: Readonly<{
  message: string | Uint8Array;
  pubkeyFile: string;
  sigFile: string;
}>): boolean {
  try {
    const message = typeof params.message === 'string' ? utf8(params.message) : params.message;
    const pubkey = parsePublicKey(params.pubkeyFile);
    const signature = parseSignature(params.sigFile);
    if (!bytesEqual(pubkey.signatureAlgorithm, ED25519_ALGORITHM)) {
      return false;
    }
    if (!bytesEqual(pubkey.keyId, signature.keyId)) {
      return false;
    }
    let payload: Uint8Array;
    if (bytesEqual(signature.signatureAlgorithm, ED25519_ALGORITHM)) {
      payload = message;
    } else if (bytesEqual(signature.signatureAlgorithm, ED25519_PREHASH_ALGORITHM)) {
      payload = blake2b(message, { dkLen: 64 });
    } else {
      return false;
    }
    return ed25519.verify(signature.signature, payload, pubkey.rawPublicKey)
      && ed25519.verify(
        signature.globalSignature,
        concatBytes(signature.signature, signature.trustedSuffix),
        pubkey.rawPublicKey,
      );
  } catch {
    return false;
  }
}
