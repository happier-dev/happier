import { createHash, createPublicKey, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const DEFAULT_MINISIGN_PUBLIC_KEY = `untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
`;

function decodeBase64Line(line: string, expectedBytes?: number): Buffer {
  const bytes = Buffer.from(String(line ?? '').trim(), 'base64');
  if (expectedBytes != null && bytes.length !== expectedBytes) {
    throw new Error(`[minisign] expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function parseMinisignPublicKeyFile(pubkeyFile: string): { signatureAlgorithm: Buffer; keyId: Buffer; rawPublicKey: Buffer } {
  const lines = String(pubkeyFile ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error('[minisign] invalid public key file');
  const payload = lines[lines.length - 1] ?? '';
  const bytes = decodeBase64Line(payload, 42);
  const signatureAlgorithm = bytes.subarray(0, 2);
  const keyId = bytes.subarray(2, 10);
  const rawPublicKey = bytes.subarray(10, 42);
  return { signatureAlgorithm, keyId, rawPublicKey };
}

function parseMinisignSignatureFile(sigFile: string): {
  signatureAlgorithm: Buffer;
  keyId: Buffer;
  signature: Buffer;
  trustedSuffix: Buffer;
  globalSignature: Buffer;
} {
  const lines = String(sigFile ?? '').split('\n');
  if (lines.length < 4) throw new Error('[minisign] invalid signature file');

  const untrustedPayload = String(lines[1] ?? '').trim();
  const trustedComment = String(lines[2] ?? '');
  const globalPayload = String(lines[3] ?? '').trim();

  const untrustedBytes = decodeBase64Line(untrustedPayload, 74);
  const signatureAlgorithm = untrustedBytes.subarray(0, 2);
  const keyId = untrustedBytes.subarray(2, 10);
  const signature = untrustedBytes.subarray(10, 74);

  const globalSignature = decodeBase64Line(globalPayload, 64);

  if (!trustedComment.startsWith('trusted comment: ')) {
    throw new Error('[minisign] unexpected trusted comment format');
  }
  const trustedSuffix = Buffer.from(trustedComment.slice('trusted comment: '.length), 'utf-8');

  return { signatureAlgorithm, keyId, signature, trustedSuffix, globalSignature };
}

function createEd25519PublicKey(rawPublicKey: Buffer) {
  if (!Buffer.isBuffer(rawPublicKey) || rawPublicKey.length !== 32) {
    throw new Error('[minisign] invalid Ed25519 public key length');
  }
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

function bytesEqual(a: Buffer, b: Buffer) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return Buffer.compare(a, b) === 0;
}

export function verifyMinisign(params: Readonly<{ message: Buffer; pubkeyFile: string; sigFile: string }>): boolean {
  try {
    const bin = Buffer.isBuffer(params.message) ? params.message : Buffer.from(params.message ?? '');
    const pubkey = parseMinisignPublicKeyFile(params.pubkeyFile);
    const sig = parseMinisignSignatureFile(params.sigFile);

    if (!bytesEqual(pubkey.signatureAlgorithm, Buffer.from('Ed'))) {
      throw new Error('[minisign] incompatible public key signature algorithm');
    }
    if (!bytesEqual(pubkey.keyId, sig.keyId)) {
      throw new Error('[minisign] incompatible key identifiers');
    }

    let prehashed = false;
    if (bytesEqual(sig.signatureAlgorithm, Buffer.from('Ed'))) {
      prehashed = false;
    } else if (bytesEqual(sig.signatureAlgorithm, Buffer.from('ED'))) {
      prehashed = true;
    } else {
      throw new Error('[minisign] unsupported signature algorithm');
    }

    const publicKey = createEd25519PublicKey(pubkey.rawPublicKey);
    const payload = prehashed ? createHash('blake2b512').update(bin).digest() : bin;

    const okSig = verify(null, payload, publicKey, sig.signature);
    if (!okSig) return false;

    const okGlobal = verify(null, Buffer.concat([sig.signature, sig.trustedSuffix]), publicKey, sig.globalSignature);
    return okGlobal;
  } catch {
    return false;
  }
}
