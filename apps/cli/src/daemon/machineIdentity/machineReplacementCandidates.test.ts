import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
            machineIdByServerId: { cloud: 'machine-current' },
            lastTokenSubByServerId: { cloud: 'account-1' },
        }),
        'utf8',
    );
}

describe('machine replacement candidates', () => {
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

    afterEach(() => {
        if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = previousHomeDir;
        if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
        else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
        vi.resetModules();
    });

    it('records and reads replacement candidates scoped by active server and account', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-replacement-candidate-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

        try {
            seedSettings(homeDir);
            vi.resetModules();
            const {
                readMachineReplacementCandidateForActiveServer,
                recordMachineReplacementCandidateForActiveServer,
            } = await import('./machineReplacementCandidates');

            await recordMachineReplacementCandidateForActiveServer({
                accountId: 'account-1',
                machineId: 'machine-old',
                replacementReason: 'reauth',
                now: 123,
            });

            await expect(readMachineReplacementCandidateForActiveServer({ accountId: 'account-1' })).resolves.toEqual({
                machineId: 'machine-old',
                replacementReason: 'reauth',
                createdAt: 123,
            });
            await expect(readMachineReplacementCandidateForActiveServer({ accountId: 'account-2' })).resolves.toBeNull();
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('reads a stale-server candidate when it is the only candidate for the account', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-replacement-candidate-stale-server-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'http-localhost-52753';

        try {
            seedSettings(homeDir);
            const raw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            raw.machineReplacementCandidatesByServerIdByAccountId = {
                cloud: {
                    'account-1': {
                        machineId: 'machine-old',
                        replacementReason: 'reauth',
                        createdAt: 123,
                    },
                },
            };
            writeFileSync(join(homeDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');

            vi.resetModules();
            const { readMachineReplacementCandidateForActiveServer } = await import('./machineReplacementCandidates');

            await expect(readMachineReplacementCandidateForActiveServer({ accountId: 'account-1' })).resolves.toEqual({
                machineId: 'machine-old',
                replacementReason: 'reauth',
                createdAt: 123,
            });
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('does not read stale-server candidates when multiple candidates are possible for the account', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-replacement-candidate-ambiguous-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'http-localhost-52753';

        try {
            seedSettings(homeDir);
            const raw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            raw.machineReplacementCandidatesByServerIdByAccountId = {
                cloud: {
                    'account-1': {
                        machineId: 'machine-old-cloud',
                        replacementReason: 'reauth',
                        createdAt: 123,
                    },
                },
                preview: {
                    'account-1': {
                        machineId: 'machine-old-preview',
                        replacementReason: 'reauth',
                        createdAt: 456,
                    },
                },
            };
            writeFileSync(join(homeDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');

            vi.resetModules();
            const { readMachineReplacementCandidateForActiveServer } = await import('./machineReplacementCandidates');

            await expect(readMachineReplacementCandidateForActiveServer({ accountId: 'account-1' })).resolves.toBeNull();
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('clearMachineId can preserve the old exact machine id as a replacement candidate', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-clear-machine-replacement-candidate-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

        try {
            seedSettings(homeDir);
            vi.resetModules();
            const { clearMachineId } = await import('@/persistence');
            await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth', now: 456 });

            const raw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            expect(raw.machineIdByServerId.cloud).toBeUndefined();
            expect(raw.machineReplacementCandidatesByServerIdByAccountId.cloud['account-1']).toEqual({
                machineId: 'machine-current',
                replacementReason: 'reauth',
                createdAt: 456,
            });
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('clearMachineId preserves a legacy machine id using the explicit replacement account id', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-clear-machine-legacy-replacement-candidate-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

        try {
            seedSettings(homeDir);
            const raw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            delete raw.lastTokenSubByServerId;
            writeFileSync(join(homeDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');

            vi.resetModules();
            const { clearMachineId } = await import('@/persistence');
            await clearMachineId({
                preserveReplacementCandidate: true,
                replacementAccountId: 'account-legacy',
                replacementReason: 'reauth',
                now: 789,
            });

            const nextRaw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            expect(nextRaw.machineIdByServerId.cloud).toBeUndefined();
            expect(nextRaw.machineReplacementCandidatesByServerIdByAccountId.cloud['account-legacy']).toEqual({
                machineId: 'machine-current',
                replacementReason: 'reauth',
                createdAt: 789,
            });
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('consumes a matching acknowledged candidate across stale server buckets', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-replacement-candidate-consume-stale-'));
        process.env.HAPPIER_HOME_DIR = homeDir;
        process.env.HAPPIER_ACTIVE_SERVER_ID = 'http-localhost-52753';

        try {
            seedSettings(homeDir);
            const raw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            raw.machineReplacementCandidatesByServerIdByAccountId = {
                cloud: {
                    'account-1': {
                        machineId: 'machine-old',
                        replacementReason: 'reauth',
                        createdAt: 123,
                    },
                },
            };
            writeFileSync(join(homeDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');

            vi.resetModules();
            const { consumeMachineReplacementCandidateAfterRegistration } = await import('./machineReplacementCandidates');

            await consumeMachineReplacementCandidateAfterRegistration({
                accountId: 'account-1',
                didRegister: true,
                replacesMachineId: 'machine-old',
            });

            const nextRaw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
            expect(nextRaw.machineReplacementCandidatesByServerIdByAccountId).toEqual({});
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
