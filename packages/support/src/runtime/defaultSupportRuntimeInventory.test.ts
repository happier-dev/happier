import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const happierRuntimeMocks = vi.hoisted(() => ({
    discoverHappierInstallationsMock: vi.fn(),
    discoverHappierServicesMock: vi.fn(),
    buildHappierRuntimeWarningsMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common', () => ({
    happierRuntime: {
        discoverHappierInstallations: happierRuntimeMocks.discoverHappierInstallationsMock,
        discoverHappierServices: happierRuntimeMocks.discoverHappierServicesMock,
        buildHappierRuntimeWarnings: happierRuntimeMocks.buildHappierRuntimeWarningsMock,
    },
}));

describe('defaultSupportRuntimeInventory', () => {
    it('collects shared Happier runtime inventory through the canonical cli-common discovery APIs', async () => {
        happierRuntimeMocks.discoverHappierInstallationsMock.mockResolvedValue({
            activeInvocation: {
                path: '/Users/tester/.happier/bin/hprev',
                realPath: '/Users/tester/.happier/cli-preview/current/happier',
                invokerName: 'hprev',
                ring: 'preview',
                version: '1.2.3-preview.4',
                installationId: 'managed:preview:/Users/tester/.happier/cli-preview/current',
            },
            installations: [
                {
                    id: 'managed:preview:/Users/tester/.happier/cli-preview/current',
                    source: 'firstPartyManaged',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'preview',
                    version: '1.2.3-preview.4',
                    path: '/Users/tester/.happier/cli-preview/current',
                    realPath: '/Users/tester/.happier/cli-preview/current',
                    shimName: 'hprev',
                    onPath: true,
                    managedRoot: '/Users/tester/.happier/cli-preview',
                },
            ],
        });
        happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
            services: [
                {
                    id: 'systemd-user:happier-daemon.preview.cloud',
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.preview.cloud',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: 'cloud',
                    scope: 'user',
                    definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.cloud.service',
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: true,
                },
            ],
        });
        happierRuntimeMocks.buildHappierRuntimeWarningsMock.mockReturnValue([
            {
                code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
                severity: 'warning',
                message: 'The running daemon was started with a different CLI version than the current invocation.',
                repairCommands: ['happier daemon restart'],
            },
        ]);

        const { defaultSupportRuntimeInventory } = await import('./defaultSupportRuntimeInventory.js');
        const inventory = await defaultSupportRuntimeInventory(
            {
                processEnv: { PATH: '/usr/bin' },
                argv: ['node', '/opt/happier-support'],
                execPath: '/usr/local/bin/node',
                nodeVersion: 'v22.0.0',
                platform: 'linux',
                packageVersion: '9.9.9',
            },
        );

        expect(happierRuntimeMocks.discoverHappierInstallationsMock).toHaveBeenCalledWith({
            processEnv: { PATH: '/usr/bin' },
            invokedPath: null,
            invokerName: null,
        });
        expect(happierRuntimeMocks.discoverHappierServicesMock).toHaveBeenCalledWith({
            processEnv: { PATH: '/usr/bin' },
            platform: 'linux',
        });
        expect(happierRuntimeMocks.buildHappierRuntimeWarningsMock).toHaveBeenCalled();
        expect(inventory).toEqual(expect.objectContaining({
            invokedBinaryPath: '/opt/happier-support',
            invokedVersion: '9.9.9',
            nodeVersion: 'v22.0.0',
            platform: 'linux',
            installations: expect.arrayContaining([
                expect.objectContaining({
                    id: 'managed:preview:/Users/tester/.happier/cli-preview/current',
                    ring: 'preview',
                    version: '1.2.3-preview.4',
                }),
            ]),
            services: expect.arrayContaining([
                expect.objectContaining({
                    id: 'systemd-user:happier-daemon.preview.cloud',
                    ring: 'preview',
                    status: 'running',
                }),
            ]),
            warnings: expect.arrayContaining([
                expect.objectContaining({
                    code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
                    severity: 'warning',
                }),
            ]),
        }));
    });

    it('falls back to the nearest package.json version for the invoked support binary', async () => {
        happierRuntimeMocks.discoverHappierInstallationsMock.mockResolvedValue({
            activeInvocation: null,
            installations: [],
        });
        happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
            services: [],
        });
        happierRuntimeMocks.buildHappierRuntimeWarningsMock.mockReturnValue([]);

        const root = mkdtempSync(join(tmpdir(), 'happier-support-runtime-'));
        try {
            const binPath = join(root, 'packages', 'support', 'bin', 'happier-support.mjs');
            await mkdir(join(root, 'packages', 'support', 'bin'), { recursive: true });
            await writeFile(binPath, '#!/usr/bin/env node\n', 'utf8');
            await chmod(binPath, 0o755);
            await writeFile(
                join(root, 'packages', 'support', 'package.json'),
                JSON.stringify({ version: '4.5.6' }),
                'utf8',
            );

            const { defaultSupportRuntimeInventory } = await import('./defaultSupportRuntimeInventory.js');
            const inventory = await defaultSupportRuntimeInventory({
                processEnv: { PATH: '/usr/bin' },
                argv: ['node', binPath],
                execPath: '/usr/local/bin/node',
                nodeVersion: 'v22.0.0',
                platform: 'linux',
            });

            expect(inventory.invokedVersion).toBe('4.5.6');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
