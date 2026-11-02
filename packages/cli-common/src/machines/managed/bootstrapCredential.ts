import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import { deriveEd25519KeyPair } from '@happier-dev/protocol/crypto/ed25519';
import { ManagedMachineControllerError } from './controllerErrors.js';

const text = new TextEncoder();
const keyType = text.encode('ssh-ed25519');
const magic = text.encode('openssh-key-v1\0');
const privateHeader = '-----BEGIN OPENSSH PRIVATE KEY-----';
const privateFooter = '-----END OPENSSH PRIVATE KEY-----';

export type ManagedBootstrapCredential = Readonly<{
    bootstrapPrivateKey: string;
    guestHostPrivateKey?: string;
    guestHostPublicKey?: string;
}>;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}

function uint32(value: number): Uint8Array {
    const result = new Uint8Array(4);
    new DataView(result.buffer).setUint32(0, value);
    return result;
}

function field(value: Uint8Array): Uint8Array { return concat(uint32(value.length), value); }
function equal(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function unavailable(): never { throw new ManagedMachineControllerError('credential_unavailable'); }

/** Portable OpenSSH key generation at the host crypto boundary. */
export function createManagedBootstrapSshKeyPair(input: Readonly<{
    randomBytes(size: number): Uint8Array;
}>): Readonly<{ privateKey: string; publicKey: string }> {
    const seed = input.randomBytes(32);
    const pair = deriveEd25519KeyPair(seed);
    seed.fill(0);
    const check = input.randomBytes(4);
    // OpenSSH PROTOCOL.key: unencrypted private list, SSH-agent Ed25519 fields,
    // and incremental padding to the "none" cipher's eight-byte block size.
    const unpadded = concat(check, check, field(keyType), field(pair.publicKey), field(pair.secretKey), field(new Uint8Array()));
    const paddingLength = 8 - unpadded.length % 8;
    const padded = concat(unpadded, Uint8Array.from({ length: paddingLength }, (_, index) => index + 1));
    const publicKey = concat(field(keyType), field(pair.publicKey));
    const encoded = concat(magic, field(text.encode('none')), field(text.encode('none')), field(new Uint8Array()), uint32(1), field(publicKey), field(padded));
    try {
        const base64 = encodeBase64(encoded);
        const privateKey = `${privateHeader}\n${base64.match(/.{1,70}/g)!.join('\n')}\n${privateFooter}\n`;
        return { privateKey, publicKey: `ssh-ed25519 ${encodeBase64(publicKey)}` };
    } finally {
        pair.secretKey.fill(0);
        unpadded.fill(0);
        padded.fill(0);
        encoded.fill(0);
    }
}

/** Both independent identities stay in the incumbent private SavedSecret value. */
export function createManagedBootstrapSshCredential(input: Readonly<{
    bootstrapPrivateKey: string;
    randomBytes(size: number): Uint8Array;
}>): string {
    const host = createManagedBootstrapSshKeyPair(input);
    return JSON.stringify({ v: 1, bootstrapPrivateKey: input.bootstrapPrivateKey, guestHostPrivateKey: host.privateKey });
}

/** Read only the generated unencrypted, single-Ed25519-key OpenSSH representation. */
export function readManagedBootstrapSshPublicKey(privateKey: string): string {
    const lines = privateKey.trim().split(/\r?\n/);
    if (lines.shift() !== privateHeader || lines.pop() !== privateFooter) return unavailable();
    const base64 = lines.join('');
    if (readCanonicalPaddedBase64DecodedLength(base64) === null) return unavailable();
    const bytes = decodeBase64(base64);
    const cursor = (source: Uint8Array) => {
        let offset = 0;
        const take = (length: number) => {
            if (offset + length > source.length) return unavailable();
            const result = source.subarray(offset, offset + length);
            offset += length;
            return result;
        };
        const number = () => {
            const value = take(4);
            return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
        };
        return { take, number, field: () => take(number()), done: () => offset === source.length,
            remaining: () => source.subarray(offset) };
    };
    try {
        const outer = cursor(bytes);
        if (!equal(outer.take(magic.length), magic) || !equal(outer.field(), text.encode('none'))
            || !equal(outer.field(), text.encode('none')) || outer.field().length !== 0 || outer.number() !== 1) return unavailable();
        const publicBlob = outer.field();
        const publicFields = cursor(publicBlob);
        if (!equal(publicFields.field(), keyType)) return unavailable();
        const publicKey = publicFields.field();
        if (publicKey.length !== 32 || !publicFields.done()) return unavailable();
        const privateBlob = outer.field();
        if (!outer.done() || privateBlob.length % 8 !== 0) return unavailable();
        const inner = cursor(privateBlob);
        if (inner.number() !== inner.number() || !equal(inner.field(), keyType) || !equal(inner.field(), publicKey)) return unavailable();
        const secretKey = inner.field();
        if (secretKey.length !== 64) return unavailable();
        const pair = deriveEd25519KeyPair(secretKey.subarray(0, 32));
        try {
            if (!equal(pair.secretKey, secretKey) || !equal(pair.publicKey, publicKey)) return unavailable();
        } finally { pair.secretKey.fill(0); }
        inner.field(); // Comment has no identity or authority meaning.
        const padding = inner.remaining();
        if (padding.length === 0 || padding.length > 8 || !padding.every((value, index) => value === index + 1)) return unavailable();
        return `ssh-ed25519 ${encodeBase64(publicBlob)}`;
    } finally { bytes.fill(0); }
}

/** Scalar RSA PEM/native-token values remain readable; a bundle never falls back to plaintext. */
export function readManagedBootstrapCredential(value: string): ManagedBootstrapCredential {
    if (!value.trim()) return unavailable();
    const trimmed = value.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { bootstrapPrivateKey: value };
    let bundle: unknown;
    try { bundle = JSON.parse(value); } catch { return unavailable(); }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || !('v' in bundle) || bundle.v !== 1
        || !('bootstrapPrivateKey' in bundle) || typeof bundle.bootstrapPrivateKey !== 'string' || !bundle.bootstrapPrivateKey.trim()
        || !('guestHostPrivateKey' in bundle) || typeof bundle.guestHostPrivateKey !== 'string'
        || Object.keys(bundle).some(key => key !== 'v' && key !== 'bootstrapPrivateKey' && key !== 'guestHostPrivateKey')) return unavailable();
    const guestHostPublicKey = readManagedBootstrapSshPublicKey(bundle.guestHostPrivateKey);
    return { bootstrapPrivateKey: bundle.bootstrapPrivateKey, guestHostPrivateKey: bundle.guestHostPrivateKey, guestHostPublicKey };
}
