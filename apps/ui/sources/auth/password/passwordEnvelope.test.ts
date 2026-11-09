import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createPasswordEnvelopeAadV1,
    encodePasswordCredentialFieldV1,
    type PasswordEnvelopeKdfV1,
    type PasswordWrappedRecoverySecretV1,
} from '@happier-dev/protocol/auth/accountPasswordCredential';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';
import { deriveKey } from '@/encryption/deriveKey';
import { arePasswordEnvelopeKdfsEqual, derivePasswordKeys, openPasswordEnvelope } from './passwordEnvelope';

const kdf = {
    algorithm: 'argon2id13', salt: encodePasswordCredentialFieldV1(new Uint8Array(16)),
    opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32,
} satisfies PasswordEnvelopeKdfV1;

async function fixture(secret: Uint8Array, signingSecret = secret) {
    const key = await deriveKey(new Uint8Array(32).fill(9), 'Happier Password Envelope', ['v1', 'wrap']);
    const header = {
        v: 1,
        accountSigningPublicKey: encodePasswordCredentialFieldV1(deriveAccountSigningPublicKey(signingSecret)),
        kdf,
        cipher: { algorithm: 'aes256gcm', nonce: encodePasswordCredentialFieldV1(new Uint8Array(12).fill(7)) },
    } as const;
    const ciphertext = await sealAes256GcmBytes({ key, nonce: new Uint8Array(12).fill(7), aad: createPasswordEnvelopeAadV1(header), plaintext: secret });
    return { key, envelope: { ...header, cipher: { ...header.cipher, ciphertext: encodePasswordCredentialFieldV1(ciphertext) } } satisfies PasswordWrappedRecoverySecretV1 };
}

describe('password envelope recovery-secret reader', () => {
    it('opens the exact existing secret and rejects authenticated envelope content bound to another signing identity', async () => {
        const secret = new Uint8Array(32).fill(4);
        const valid = await fixture(secret);
        await expect(openPasswordEnvelope(valid.envelope, valid.key)).resolves.toEqual(secret);
        const swapped = await fixture(secret, new Uint8Array(32).fill(5));
        await expect(openPasswordEnvelope(swapped.envelope, swapped.key)).rejects.toThrow('password_authentication_failed');
    });

    it('rejects corrupt ciphertext, unbound KDF facts, unsafe allocation bounds and unknown fields', async () => {
        const { envelope, key } = await fixture(new Uint8Array(32).fill(4));
        for (const candidate of [
            { ...envelope, cipher: { ...envelope.cipher, ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48)) } },
            { ...envelope, kdf: { ...kdf, salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(9)) } },
            { ...envelope, kdf: { ...kdf, opsLimit: 4 } },
            { ...envelope, kdf: { ...kdf, memLimitBytes: 1024 ** 4 } },
            { ...envelope, accountId: 'untrusted' },
        ]) {
            await expect(openPasswordEnvelope(candidate, key)).rejects.toThrow('password_authentication_failed');
        }
    });

    it('requires exact prelogin KDF facts before using the returned envelope', () => {
        expect(arePasswordEnvelopeKdfsEqual(kdf, { ...kdf })).toBe(true);
        for (const candidate of [
            { ...kdf, salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(1)) },
            { ...kdf, opsLimit: 4 },
            { ...kdf, memLimitBytes: 128 * 1024 * 1024 },
        ]) expect(arePasswordEnvelopeKdfsEqual(kdf, candidate)).toBe(false);
    });
});

// Worker is the actual OS/browser boundary. Everything below it is real crypto;
// the independent libsodium/noble vector is also exercised in the browser probe.
describe('password KDF browser boundary', () => {
    it('rejects malformed Unicode and unsafe KDF parameters before a worker exists', async () => {
        const { derivePasswordEnvelopeKey } = await import('./derivePasswordEnvelopeKey.web');
        await expect(derivePasswordEnvelopeKey({ password: 'fifteen characters\ud800', kdf })).rejects.toThrow('password_text_rejected');
        await expect(derivePasswordEnvelopeKey({ password: 'fifteen characters', kdf: { ...kdf, memLimitBytes: 1024 ** 4 } })).rejects.toThrow('password_kdf_invalid');
    });
});

const rootVector = Uint8Array.from(Buffer.from('15970c8530df32051a4380d785f20f03abc0ecb88dba6b00222e93b1b74e0a02', 'hex'));
afterEach(() => vi.unstubAllGlobals());

it('preserves a leading Unicode BOM as password text across the worker boundary', async () => {
    let returnedKey: Uint8Array | undefined;
    const postMessage = vi.fn((message: { ok: boolean; key?: Uint8Array }) => {
        // A real worker message port clones bytes before the worker clears them.
        returnedKey = message.key?.slice();
    });
    vi.stubGlobal('postMessage', postMessage);
    vi.stubGlobal('onmessage', null);
    await import('./passwordKdf.worker');
    // Exercise the actual worker handler and WASM primitive; only its message port is replaced.
    const handler = (globalThis as unknown as { onmessage: ((event: MessageEvent) => Promise<void>) | null }).onmessage;
    expect(handler).toBeTypeOf('function');
    await handler?.(new MessageEvent('message', {
        data: { password: new TextEncoder().encode('\ufeffa password with spaces 🗝'), kdf },
    }));
    expect(postMessage).toHaveBeenCalledWith({ ok: true, key: expect.any(Uint8Array) });
    // libsodium 0.7.16 Argon2id13 over the original UTF-8 bytes, including EF BB BF.
    expect(Buffer.from(returnedKey ?? []).toString('hex')).toBe('89d02fc03407c4f993f75f2bad814f6377fb822162fd0b0266e677e0c67da923');
});

it('derives distinct wrapping/authentication keys from exact UTF-8 off-thread and discards the root', async () => {
    let returnedRoot: Uint8Array | undefined;
    let terminated = false;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: (() => void) | null = null;
        onmessageerror: (() => void) | null = null;
        postMessage(input: { password: Uint8Array; kdf: PasswordEnvelopeKdfV1 }) {
            expect(input.password).toEqual(new TextEncoder().encode('a password with spaces 🗝'));
            expect(input.kdf).toEqual(kdf);
            returnedRoot = rootVector.slice();
            queueMicrotask(() => this.onmessage?.({ data: { ok: true, key: returnedRoot } }));
        }
        terminate() { terminated = true; }
    });
    const keys = await derivePasswordKeys('a password with spaces 🗝', kdf);
    expect(Buffer.from(keys.wrapKey).toString('hex')).toBe('04cb8126b92472773652321e328021c0e896f447aaea9e1c5dd2ca9a8d0297a0');
    expect(Buffer.from(keys.authKey).toString('hex')).toBe('b1b4055eec4fc713b404eb65d1b9f6e5f500fece7634bed970759885ca2cab11');
    expect(returnedRoot).toEqual(new Uint8Array(32));
    expect(terminated).toBe(true);
});

it('terminates a cancelled worker and rejects late key completion', async () => {
    let complete: (() => void) | undefined;
    let terminated = false;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror: (() => void) | null = null;
        onmessageerror: (() => void) | null = null;
        postMessage() { complete = () => this.onmessage?.({ data: { ok: true, key: rootVector.slice() } }); }
        terminate() { terminated = true; }
    });
    const { derivePasswordEnvelopeKey } = await import('./derivePasswordEnvelopeKey.web');
    const abort = new AbortController();
    const operation = derivePasswordEnvelopeKey({ password: 'a password with spaces 🗝', kdf, signal: abort.signal });
    abort.abort();
    complete?.();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminated).toBe(true);
});
