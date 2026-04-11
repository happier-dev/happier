import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const happierRuntimeMocks = vi.hoisted(() => ({
    discoverHappierInstallationsMock: vi.fn(),
    discoverHappierServicesMock: vi.fn(),
    buildHappierRuntimeWarningsMock: vi.fn(),
    normalizeHappierRuntimePathMock: vi.fn((value: string | null | undefined) => value ?? null),
    isHappierRuntimePathWithinRootMock: vi.fn((path: string | null | undefined, root: string | null | undefined) => {
        const normalizedPath = String(path ?? '');
        const normalizedRoot = String(root ?? '');
        return normalizedPath.length > 0 && normalizedRoot.length > 0 && normalizedPath.startsWith(normalizedRoot);
    }),
    resolveHappierServiceRuntimeTargetMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', () => ({
    discoverHappierInstallations: happierRuntimeMocks.discoverHappierInstallationsMock,
    discoverHappierServices: happierRuntimeMocks.discoverHappierServicesMock,
    buildHappierRuntimeWarnings: happierRuntimeMocks.buildHappierRuntimeWarningsMock,
    normalizeHappierRuntimePath: happierRuntimeMocks.normalizeHappierRuntimePathMock,
    isHappierRuntimePathWithinRoot: happierRuntimeMocks.isHappierRuntimePathWithinRootMock,
    resolveHappierServiceRuntimeTarget: happierRuntimeMocks.resolveHappierServiceRuntimeTargetMock,
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
                    realPath: '/Users/tester/.happier/cli-preview/versions/1.2.3-preview.4',
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
                    targetMode: 'default-following',
                    ring: 'preview',
                    instanceId: 'cloud',
                    scope: 'user',
                    definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.cloud.service',
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: true,
                    serverUrl: 'https://relay.preview.example.test',
                    publicServerUrl: 'https://relay.preview.example.test',
                },
                {
                    id: 'launchd:happier-server-preview',
                    serviceType: 'self-host-service',
                    platform: 'darwin',
                    backend: 'launchd',
                    label: 'happier-server-preview',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: null,
                    scope: 'system',
                    definitionPath: '/Library/LaunchDaemons/happier-server-preview.plist',
                    executablePath: '/Users/tester/.happier/self-host/preview/happier-server',
                    installed: true,
                    running: false,
                    serverUrl: 'https://preview.example.test',
                    publicServerUrl: 'https://preview.example.test',
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
        happierRuntimeMocks.resolveHappierServiceRuntimeTargetMock.mockReturnValue({
            id: 'installation:managed:preview:/Users/tester/.happier/cli-preview/current',
            kind: 'installation',
            label: '/Users/tester/.happier/cli-preview/current',
            path: '/Users/tester/.happier/cli-preview/current',
            executablePath: '/Users/tester/.happier/cli-preview/current/happier',
            installationId: 'managed:preview:/Users/tester/.happier/cli-preview/current',
            installationPath: '/Users/tester/.happier/cli-preview/current',
        });

        const { defaultSupportRuntimeInventory } = await import('./defaultSupportRuntimeInventory.js');
        const inventory = await defaultSupportRuntimeInventory(
            {
                processEnv: { PATH: '/usr/bin' },
                argv: ['node', '/opt/hsupport'],
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
            invokedBinaryPath: '/opt/hsupport',
            invokedVersion: '9.9.9',
            nodeVersion: 'v22.0.0',
            platform: 'linux',
            installations: expect.arrayContaining([
                expect.objectContaining({
                    id: 'managed:preview:/Users/tester/.happier/cli-preview/current',
                    ring: 'preview',
                    version: '1.2.3-preview.4',
                    path: '/Users/tester/.happier/cli-preview/current',
                    realPath: '/Users/tester/.happier/cli-preview/versions/1.2.3-preview.4',
                    shimName: 'hprev',
                }),
            ]),
            services: expect.arrayContaining([
                expect.objectContaining({
                    id: 'systemd-user:happier-daemon.preview.cloud',
                    targetMode: 'default-following',
                    ring: 'preview',
                    status: 'running',
                    path: '/home/tester/.config/systemd/user/happier-daemon.preview.cloud.service',
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    linkedInstallationId: 'managed:preview:/Users/tester/.happier/cli-preview/current',
                    linkedInstallationPath: '/Users/tester/.happier/cli-preview/current',
                    serverUrl: 'https://relay.preview.example.test',
                }),
                expect.objectContaining({
                    id: 'launchd:happier-server-preview',
                    label: 'Self-host service: happier-server-preview',
                    kind: 'self-host-service',
                    status: 'installed',
                    serverUrl: 'https://preview.example.test',
                }),
            ]),
            runtimeTargets: [],
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
        happierRuntimeMocks.resolveHappierServiceRuntimeTargetMock.mockReturnValue(null);

        const root = mkdtempSync(join(tmpdir(), 'hsupport-runtime-'));
        try {
            const binPath = join(root, 'packages', 'support', 'bin', 'hsupport.mjs');
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

    it('resolves the invoked support version through the real binary path when launched from an npm .bin shim', async () => {
        happierRuntimeMocks.discoverHappierInstallationsMock.mockResolvedValue({
            activeInvocation: null,
            installations: [],
        });
        happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
            services: [],
        });
        happierRuntimeMocks.buildHappierRuntimeWarningsMock.mockReturnValue([]);
        happierRuntimeMocks.resolveHappierServiceRuntimeTargetMock.mockReturnValue(null);

        const root = mkdtempSync(join(tmpdir(), 'hsupport-runtime-shim-'));
        try {
            const packageBinPath = join(root, 'node_modules', '@happier-dev', 'support', 'bin', 'hsupport.mjs');
            const shimPath = join(root, 'node_modules', '.bin', 'hsupport');
            await mkdir(join(root, 'node_modules', '@happier-dev', 'support', 'bin'), { recursive: true });
            await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
            await writeFile(packageBinPath, '#!/usr/bin/env node\n', 'utf8');
            await chmod(packageBinPath, 0o755);
            await writeFile(
                join(root, 'node_modules', '@happier-dev', 'support', 'package.json'),
                JSON.stringify({ version: '7.8.9' }),
                'utf8',
            );
            await symlink('../@happier-dev/support/bin/hsupport.mjs', shimPath);

            const { defaultSupportRuntimeInventory } = await import('./defaultSupportRuntimeInventory.js');
            const inventory = await defaultSupportRuntimeInventory({
                processEnv: { PATH: '/usr/bin' },
                argv: ['node', shimPath],
                execPath: '/usr/local/bin/node',
                nodeVersion: 'v22.0.0',
                platform: 'linux',
            });

            expect(inventory.invokedVersion).toBe('7.8.9');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('surfaces non-canonical runtime targets separately from managed installations and links unmatched services to them', async () => {
        happierRuntimeMocks.discoverHappierInstallationsMock.mockResolvedValue({
            activeInvocation: null,
            installations: [
                {
                    id: 'managed:stable:/Users/tester/.happier/cli/current',
                    source: 'firstPartyManaged',
                    components: ['happier-cli', 'happier-daemon'],
                    ring: 'stable',
                    version: '1.2.3',
                    path: '/Users/tester/.happier/cli/current',
                    realPath: '/Users/tester/.happier/cli/versions/1.2.3',
                    shimName: 'happier',
                    onPath: true,
                    managedRoot: '/Users/tester/.happier/cli',
                },
            ],
        });
        happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
            services: [
                {
                    id: 'stack-runtime-service',
                    serviceType: 'daemon',
                    platform: 'darwin',
                    backend: 'launchd',
                    label: 'com.happier.cli.daemon.stack_main_id_default',
                    verification: 'verified',
                    ring: 'stable',
                    instanceId: 'stack_main_id_default',
                    scope: 'user',
                    definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.stack_main_id_default.plist',
                    executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
                    installed: true,
                    running: false,
                },
                {
                    id: 'source-service',
                    serviceType: 'daemon',
                    platform: 'darwin',
                    backend: 'launchd',
                    label: 'com.happier.cli.daemon.custom',
                    verification: 'verified',
                    ring: 'stable',
                    instanceId: 'custom',
                    scope: 'user',
                    definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.custom.plist',
                    executablePath: '/Users/tester/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs',
                    installed: true,
                    running: true,
                },
            ],
        });
        happierRuntimeMocks.buildHappierRuntimeWarningsMock.mockReturnValue([]);
        happierRuntimeMocks.resolveHappierServiceRuntimeTargetMock.mockImplementation((input: { service: { id: string } }) => {
            if (input.service.id === 'stack-runtime-service') {
                return {
                    id: 'stack-runtime:/Users/tester/.happier/stacks/main/cli',
                    kind: 'stack-runtime',
                    label: 'Stack runtime (main)',
                    path: '/Users/tester/.happier/stacks/main/cli',
                    executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
                    installationId: null,
                    installationPath: null,
                };
            }
            if (input.service.id === 'source-service') {
                return {
                    id: 'source-checkout:/Users/tester/Documents/Development/happier/dev',
                    kind: 'source-checkout',
                    label: 'Source checkout (dev)',
                    path: '/Users/tester/Documents/Development/happier/dev',
                    executablePath: '/Users/tester/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs',
                    installationId: null,
                    installationPath: null,
                };
            }
            return null;
        });

        const { defaultSupportRuntimeInventory } = await import('./defaultSupportRuntimeInventory.js');
        const inventory = await defaultSupportRuntimeInventory({
            processEnv: { PATH: '/usr/bin' },
            argv: ['node', '/opt/hsupport'],
            execPath: '/usr/local/bin/node',
            nodeVersion: 'v22.0.0',
            platform: 'darwin',
            packageVersion: '9.9.9',
        });

        expect(inventory.runtimeTargets).toEqual([
            expect.objectContaining({
                id: 'stack-runtime:/Users/tester/.happier/stacks/main/cli',
                label: 'Stack runtime (main)',
                category: 'stack-runtime',
                path: '/Users/tester/.happier/stacks/main/cli',
                executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
                linkedServiceIds: ['stack-runtime-service'],
            }),
            expect.objectContaining({
                id: 'source-checkout:/Users/tester/Documents/Development/happier/dev',
                label: 'Source checkout (dev)',
                category: 'source-checkout',
                path: '/Users/tester/Documents/Development/happier/dev',
                executablePath: '/Users/tester/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs',
                linkedServiceIds: ['source-service'],
            }),
        ]);
        expect(inventory.services).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'stack-runtime-service',
                linkedInstallationId: null,
                linkedRuntimeTargetId: 'stack-runtime:/Users/tester/.happier/stacks/main/cli',
                linkedRuntimeTargetLabel: 'Stack runtime (main)',
                linkedRuntimeTargetPath: '/Users/tester/.happier/stacks/main/cli',
                linkedRuntimeTargetCategory: 'stack-runtime',
            }),
            expect.objectContaining({
                id: 'source-service',
                linkedInstallationId: null,
                linkedRuntimeTargetId: 'source-checkout:/Users/tester/Documents/Development/happier/dev',
                linkedRuntimeTargetLabel: 'Source checkout (dev)',
                linkedRuntimeTargetPath: '/Users/tester/Documents/Development/happier/dev',
                linkedRuntimeTargetCategory: 'source-checkout',
            }),
        ]));
    });
});
