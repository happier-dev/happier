import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMachineInstallationProof } from '@happier-dev/protocol';

function createJwt(sub: string): string {
    return [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url'),
        Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url'),
        '',
    ].join('.');
}

function seedSettings(homeDir: string): void {
    writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify({
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
                cloud: {
                    id: 'cloud',
                    name: 'cloud',
                    serverUrl: 'https://api.happier.dev',
                    webappUrl: 'https://app.happier.dev',
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                },
            },
            machineReplacementCandidatesByServerIdByAccountId: {
                cloud: {
                    'account-1': {
                        machineId: 'machine-old',
                        replacementReason: 'reauth',
                        createdAt: 123,
                    },
                },
            },
        }),
        'utf8',
    );
}

describe('resolveMachineRegistrationIdentity', () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

    afterEach(() => {
        if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = previousHomeDir;
        if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
        else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
        vi.resetModules();
    });

    it('builds registration identity with explicit replacement intent and content key fingerprint', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-registration-identity-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

        try {
            seedSettings(homeDir);
            vi.resetModules();
            const { resolveMachineRegistrationIdentity } = await import('./resolveMachineRegistrationIdentity');

            const identity = await resolveMachineRegistrationIdentity({
                machineId: 'machine-new',
                token: createJwt('account-1'),
                contentPublicKey: new Uint8Array([1, 2, 3]),
            });

            expect(identity).toEqual(expect.objectContaining({
                installationId: expect.any(String),
                installationPublicKey: expect.any(String),
                installationProof: expect.objectContaining({
                    version: 1,
                    algorithm: 'ed25519',
                    signature: expect.any(String),
                }),
                replacesMachineId: 'machine-old',
                replacementReason: 'reauth',
                replacementCandidateAccountId: 'account-1',
                contentPublicKeyFingerprint: expect.stringMatching(/^content-public-key-sha256:[a-f0-9]{64}$/u),
            }));
            expect(verifyMachineInstallationProof({
                payload: identity.payload,
                proof: identity.installationProof,
                publicKey: identity.installationPublicKey,
            })).toBe(true);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
