import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha512, key, data);
}

type KeyTreeState = Readonly<{ key: Uint8Array; chainCode: Uint8Array }>;

function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): KeyTreeState {
  const I = hmacSha512(encodeUtf8(`${usage} Master Seed`), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): KeyTreeState {
  const indexBytes = encodeUtf8(index);
  const data = new Uint8Array(1 + indexBytes.length);
  data[0] = 0;
  data.set(indexBytes, 1);
  const I = hmacSha512(chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

export function deriveKey(master: Uint8Array, usage: string, path: readonly string[]): Uint8Array {
  let state = deriveSecretKeyTreeRoot(master, usage);
  for (const index of path) {
    state = deriveSecretKeyTreeChild(state.chainCode, index);
  }
  return state.key;
}
