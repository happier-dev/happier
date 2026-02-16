const credentialTokenEncoder = new TextEncoder();
const credentialTokenDecoder = new TextDecoder();

function toPrismaBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Uint8Array(sliced);
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  const copy = new Uint8Array(buffer);
  copy.set(bytes);
  return copy;
}

export function decodeCredentialTokenString(tokenBytes: Uint8Array): string {
  return credentialTokenDecoder.decode(tokenBytes);
}

export function encodeCredentialTokenBytes(ciphertext: string): Uint8Array<ArrayBuffer> {
  return toPrismaBytes(credentialTokenEncoder.encode(ciphertext));
}

