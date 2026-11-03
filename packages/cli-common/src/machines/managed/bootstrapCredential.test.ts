import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createManagedBootstrapSshCredential, readManagedBootstrapCredential } from './bootstrapCredential.js';

const randomBytes = (size: number) => new Uint8Array(size).fill(9);
const loginPrivateKey = '-----BEGIN RSA PRIVATE KEY-----\nretained-login-fixture\n-----END RSA PRIVATE KEY-----\n';

describe('retained managed bootstrap credential', () => {
    it('keeps the guest identity in the same private value and recovers it without fresh randomness', () => {
        const value = createManagedBootstrapSshCredential({ bootstrapPrivateKey: loginPrivateKey, randomBytes });
        const first = readManagedBootstrapCredential(value);
        const resumed = readManagedBootstrapCredential(value);
        expect(first).toEqual(resumed);
        expect(first.bootstrapPrivateKey).toBe(loginPrivateKey);
        expect(first.guestHostPrivateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
        expect(first.guestHostPublicKey).toMatch(/^ssh-ed25519 /);
        expect(first.guestHostPrivateKey).not.toContain(loginPrivateKey);
    });

    it.each([loginPrivateKey, 'retained-native-token'])('preserves scalar bootstrap credentials without inventing a guest identity', value => {
        expect(readManagedBootstrapCredential(value)).toEqual({ bootstrapPrivateKey: value });
    });

    it.each(['{', '{"v":2,"bootstrapPrivateKey":"login","guestHostPrivateKey":"host"}',
        '{"v":1,"bootstrapPrivateKey":"login"}', '{"v":1,"bootstrapPrivateKey":"login","guestHostPrivateKey":"bad"}',
        '[]'])('refuses malformed/version-mismatched bundles without disclosing their contents', value => {
        expect(() => readManagedBootstrapCredential(value)).toThrowError(expect.objectContaining({ code: 'credential_unavailable', message: 'credential_unavailable' }));
    });

    it('rejects substituted public/private material inside a well-shaped retained bundle', () => {
        const original: unknown = JSON.parse(createManagedBootstrapSshCredential({ bootstrapPrivateKey: loginPrivateKey, randomBytes }));
        if (!original || typeof original !== 'object' || !('guestHostPrivateKey' in original)
            || typeof original.guestHostPrivateKey !== 'string') throw new Error('Expected generated private bundle');
        const encoded = original.guestHostPrivateKey.split('\n').slice(1, -2).join('');
        const bytes = Buffer.from(encoded, 'base64');
        // The last 32-byte public key is embedded in the Ed25519 secret field.
        // Change its first byte while leaving the outer public carrier intact.
        const publicKey = readManagedBootstrapCredential(JSON.stringify(original)).guestHostPublicKey!;
        const publicBytes = Buffer.from(publicKey.split(' ')[1]!, 'base64').subarray(-32);
        const secretPublicOffset = bytes.lastIndexOf(publicBytes);
        expect(secretPublicOffset).toBeGreaterThan(0);
        bytes[secretPublicOffset] = bytes[secretPublicOffset]! ^ 1;
        const guestHostPrivateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${bytes.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
        expect(() => readManagedBootstrapCredential(JSON.stringify({ ...original, guestHostPrivateKey })))
            .toThrowError(expect.objectContaining({ code: 'credential_unavailable' }));
    });

    it.skipIf(spawnSync('ssh-keygen', ['-?']).error?.message.includes('ENOENT') === true)(
        'produces an Ed25519 OpenSSH private key accepted by the native installer tool', async () => {
            const directory = await mkdtemp(join(tmpdir(), 'happier-bootstrap-key-'));
            try {
                const credential = readManagedBootstrapCredential(createManagedBootstrapSshCredential({ bootstrapPrivateKey: loginPrivateKey, randomBytes }));
                const keyPath = join(directory, 'id_ed25519');
                await writeFile(keyPath, credential.guestHostPrivateKey!, { mode: 0o600 });
                expect(execFileSync('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' }).trim()).toBe(credential.guestHostPublicKey);
                expect(await readFile(keyPath, 'utf8')).toBe(credential.guestHostPrivateKey);
            } finally { await rm(directory, { recursive: true, force: true }); }
        });
});
