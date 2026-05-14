import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';

function createTestIdentity(installationId: string, publicKeyBytes?: Uint8Array): unknown {
    const keyPair = tweetnacl.sign.keyPair();
    return {
        version: 1,
        installationId,
        createdAt: 1,
        publicKey: Buffer.from(publicKeyBytes ?? keyPair.publicKey).toString('base64url'),
        privateKey: Buffer.from(keyPair.secretKey).toString('base64url'),
    };
}

describe('installation identity store', () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;

    afterEach(() => {
        if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = previousHomeDir;
        vi.resetModules();
    });

    it('mints one local installation identity and persists it with private file permissions', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-installation-identity-'));
        process.env.HAPPIER_HOME_DIR = homeDir;

        try {
            vi.resetModules();
            const { configuration } = await import('@/configuration');
            const { readOrCreateInstallationIdentity } = await import('./store');

            const first = await readOrCreateInstallationIdentity();
            const second = await readOrCreateInstallationIdentity();

            expect(second).toEqual(first);
            expect(first.version).toBe(1);
            expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/u);
            expect(JSON.parse(readFileSync(configuration.installationIdentityFile, 'utf8'))).toEqual(first);
            if (process.platform !== 'win32') {
                expect(statSync(configuration.installationIdentityFile).mode & 0o777).toBe(0o600);
            }
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('fails clearly instead of silently replacing a corrupt identity file', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-installation-identity-corrupt-'));
        process.env.HAPPIER_HOME_DIR = homeDir;

        try {
            vi.resetModules();
            const { configuration } = await import('@/configuration');
            writeFileSync(configuration.installationIdentityFile, '{"version":1,"installationId":""}', 'utf8');

            const { readOrCreateInstallationIdentity } = await import('./store');
            await expect(readOrCreateInstallationIdentity()).rejects.toThrow(/installation identity/i);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('fails clearly when persisted key material is malformed', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-installation-identity-bad-key-'));
        process.env.HAPPIER_HOME_DIR = homeDir;

        try {
            vi.resetModules();
            const { configuration } = await import('@/configuration');
            writeFileSync(
                configuration.installationIdentityFile,
                JSON.stringify(createTestIdentity('installation-1', new Uint8Array(31)), null, 2),
                'utf8',
            );

            const { readOrCreateInstallationIdentity } = await import('./store');
            await expect(readOrCreateInstallationIdentity()).rejects.toThrow(/publicKey/i);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('reads the identity that won a concurrent first-use create race', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-installation-identity-race-'));
        process.env.HAPPIER_HOME_DIR = homeDir;

        try {
            vi.resetModules();
            const { configuration } = await import('@/configuration');
            const { readOrCreateInstallationIdentity } = await import('./store');
            const [first, second] = await Promise.all([
                readOrCreateInstallationIdentity(),
                readOrCreateInstallationIdentity(),
            ]);

            expect(second).toEqual(first);
            expect(JSON.parse(readFileSync(configuration.installationIdentityFile, 'utf8'))).toEqual(first);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('survives credential and machine-id clearing', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-installation-identity-clear-'));
        process.env.HAPPIER_HOME_DIR = homeDir;

        try {
            vi.resetModules();
            const { readOrCreateInstallationIdentity } = await import('./store');
            const { clearCredentials, clearMachineId } = await import('@/persistence');

            const before = await readOrCreateInstallationIdentity();
            await clearCredentials();
            await clearMachineId();

            await expect(readOrCreateInstallationIdentity()).resolves.toEqual(before);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('can read an existing identity without minting one when absent', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-installation-identity-read-existing-'));
        process.env.HAPPIER_HOME_DIR = homeDir;

        try {
            vi.resetModules();
            const { configuration } = await import('@/configuration');
            const { readInstallationIdentityIfExistsSync, readOrCreateInstallationIdentity } = await import('./store');

            expect(readInstallationIdentityIfExistsSync()).toBeNull();
            expect(existsSync(configuration.installationIdentityFile)).toBe(false);
            const created = await readOrCreateInstallationIdentity();
            expect(readInstallationIdentityIfExistsSync()).toEqual(created);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
