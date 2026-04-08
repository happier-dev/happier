import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderSystemdServiceUnit } from '../../service/systemd.js';
import { renderWindowsScheduledTaskWrapperPs1 } from '../../service/windows.js';

import { discoverHappierServices } from './discoverHappierServices.js';

describe('discoverHappierServices', () => {
    it('discovers Windows scheduled-task wrappers from user scope', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-win32-'));
        try {
            const userRoot = join(root, 'services');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.dev.cloud.ps1'),
                renderWindowsScheduledTaskWrapperPs1({
                    workingDirectory: 'C:\\Users\\tester',
                    programArgs: [
                        'C:\\Program Files\\nodejs\\node.exe',
                        'C:\\Users\\tester\\.happier\\cli-dev\\current\\package-dist\\index.mjs',
                        'daemon',
                        'start-sync',
                    ],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
                    },
                    stdoutPath: 'C:\\Users\\tester\\.happier\\logs\\daemon.out.log',
                    stderrPath: 'C:\\Users\\tester\\.happier\\logs\\daemon.err.log',
                }),
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'win32',
                roots: [{ path: userRoot, scope: 'user' }],
                commands: {
                    run: ({ cmd, args }) => {
                        if (cmd !== 'schtasks') return null;
                        if (args.includes('/Query')) {
                            return 'TaskName: \\Happier\\happier-daemon.dev.cloud\r\nStatus: Running\r\n';
                        }
                        return null;
                    },
                },
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'win32',
                    backend: 'schtasks-user',
                    label: 'happier-daemon.dev.cloud',
                    verification: 'verified',
                    ring: 'dev',
                    instanceId: 'cloud',
                    scope: 'user',
                    definitionPath: join(userRoot, 'happier-daemon.dev.cloud.ps1'),
                    executablePath: 'C:\\Users\\tester\\.happier\\cli-dev\\current\\package-dist\\index.mjs',
                    installed: true,
                    running: true,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers macOS LaunchDaemons from the system scope', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-darwin-'));
        try {
            const systemRoot = join(root, 'LaunchDaemons');
            await mkdir(systemRoot, { recursive: true });

            await writeFile(
                join(systemRoot, 'com.happier.cli.daemon.preview.cloud.plist'),
                `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.happier.cli.daemon.preview.cloud</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/tester/.happier/cli-preview/current/happier</string>
      <string>daemon</string>
      <string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_ACTIVE_SERVER_ID</key>
      <string>cloud</string>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>preview</string>
    </dict>
  </dict>
</plist>`,
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'darwin',
                roots: [{ path: systemRoot, scope: 'system' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'darwin',
                    backend: 'launchd',
                    label: 'com.happier.cli.daemon.preview.cloud',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: 'cloud',
                    scope: 'system',
                    definitionPath: join(systemRoot, 'com.happier.cli.daemon.preview.cloud.plist'),
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: false,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers explicit Happier daemon and stack services while ignoring upstream happy services', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.preview.cloud.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/usr/bin/node', '/Users/tester/.happier/cli-preview/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                        HAPPIER_SERVER_URL: 'https://preview.example.test',
                        HAPPIER_PUBLIC_SERVER_URL: 'https://preview.example.test',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            await writeFile(
                join(userRoot, 'dev.happier.stack.dev-built.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Stack',
                    execStart: ['/Users/tester/.happier-stack/bin/hstack', 'run'],
                    env: {
                        HAPPIER_STACK_ENV_FILE: '/Users/tester/.happier/stacks/dev-built/env',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            await writeFile(
                join(userRoot, 'happy-daemon.preview.cloud.service'),
                renderSystemdServiceUnit({
                    description: 'Upstream Happy Daemon',
                    execStart: ['/usr/bin/happy', 'daemon', 'start-sync'],
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'stack-service',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'dev.happier.stack.dev-built',
                    verification: 'verified',
                    ring: null,
                    instanceId: 'dev-built',
                    scope: 'user',
                    definitionPath: join(userRoot, 'dev.happier.stack.dev-built.service'),
                    executablePath: '/Users/tester/.happier-stack/bin/hstack',
                    installed: true,
                    running: false,
                }),
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.preview.cloud',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: 'cloud',
                    scope: 'user',
                    definitionPath: join(userRoot, 'happier-daemon.preview.cloud.service'),
                    executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: false,
                    serverUrl: 'https://preview.example.test',
                    publicServerUrl: 'https://preview.example.test',
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each([
        {
            platform: 'darwin' as const,
            rootName: 'LaunchAgents',
            fileName: 'happier-server-dev.plist',
            backend: 'launchd' as const,
            definition: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>happier-server-dev</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/tester/.happier/self-host/dev/happier-server</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HAPPIER_PUBLIC_RELEASE_CHANNEL</key>
      <string>dev</string>
      <key>HAPPIER_SERVER_URL</key>
      <string>https://dev.example.test</string>
      <key>HAPPIER_PUBLIC_SERVER_URL</key>
      <string>https://dev.example.test</string>
    </dict>
  </dict>
</plist>`,
            executablePath: '/Users/tester/.happier/self-host/dev/happier-server',
            ring: 'dev' as const,
            serverUrl: 'https://dev.example.test',
        },
        {
            platform: 'linux' as const,
            rootName: 'systemd-user',
            fileName: 'happier-server-preview.service',
            backend: 'systemd-user' as const,
            definition: renderSystemdServiceUnit({
                description: 'Happier Server',
                execStart: ['/Users/tester/.happier/self-host/preview/happier-server', 'serve'],
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                    HAPPIER_SERVER_URL: 'https://preview.example.test',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://preview.example.test',
                },
                wantedBy: 'default.target',
            }),
            executablePath: '/Users/tester/.happier/self-host/preview/happier-server',
            ring: 'preview' as const,
            serverUrl: 'https://preview.example.test',
        },
        {
            platform: 'win32' as const,
            rootName: 'services',
            fileName: 'happier-server-stable.ps1',
            backend: 'schtasks-user' as const,
            definition: renderWindowsScheduledTaskWrapperPs1({
                workingDirectory: 'C:\\Users\\tester',
                programArgs: [
                    'C:\\Users\\tester\\.happier\\self-host\\stable\\happier-server.exe',
                    'serve',
                ],
                env: {
                    HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
                    HAPPIER_SERVER_URL: 'https://stable.example.test',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://stable.example.test',
                },
                stdoutPath: 'C:\\Users\\tester\\.happier\\logs\\self-host.out.log',
                stderrPath: 'C:\\Users\\tester\\.happier\\logs\\self-host.err.log',
            }),
            executablePath: 'C:\\Users\\tester\\.happier\\self-host\\stable\\happier-server.exe',
            ring: 'stable' as const,
            serverUrl: 'https://stable.example.test',
        },
    ])('discovers self-host services on $platform', async (params) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-self-host-'));
        try {
            const serviceRoot = join(root, params.rootName);
            await mkdir(serviceRoot, { recursive: true });
            await writeFile(join(serviceRoot, params.fileName), params.definition, 'utf8');

            const inventory = await discoverHappierServices({
                platform: params.platform,
                roots: [{ path: serviceRoot, scope: 'user' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'self-host-service',
                    platform: params.platform,
                    backend: params.backend,
                    label: params.fileName.replace(/\.(plist|service|ps1)$/u, ''),
                    verification: 'verified',
                    ring: params.ring,
                    instanceId: null,
                    scope: 'user',
                    definitionPath: join(serviceRoot, params.fileName),
                    executablePath: params.executablePath,
                    installed: true,
                    running: false,
                    serverUrl: params.serverUrl,
                    publicServerUrl: params.serverUrl,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discovers default-following daemon services from the canonical target marker', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-default-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.default.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/Users/tester/.happier/cli/current/happier', 'daemon', 'start-sync'],
                    env: {
                        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            const inventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
            });

            expect(inventory.services).toEqual([
                expect.objectContaining({
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.default',
                    verification: 'verified',
                    targetMode: 'default-following',
                    ring: null,
                    instanceId: null,
                    scope: 'user',
                    definitionPath: join(userRoot, 'happier-daemon.default.service'),
                    executablePath: '/Users/tester/.happier/cli/current/happier',
                    installed: true,
                    running: false,
                    serverUrl: null,
                    publicServerUrl: null,
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('omits candidate services by default and includes them only in deep mode', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-runtime-services-deep-'));
        try {
            const userRoot = join(root, 'systemd-user');
            await mkdir(userRoot, { recursive: true });

            await writeFile(
                join(userRoot, 'happier-daemon.preview.cloud.service'),
                renderSystemdServiceUnit({
                    description: 'Happier Daemon',
                    execStart: ['/usr/bin/node', '/Users/tester/.happier/cli-preview/current/happier', 'serve'],
                    env: {
                        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
                        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
                    },
                    wantedBy: 'default.target',
                }),
                'utf8',
            );

            const defaultInventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
            });
            expect(defaultInventory.services).toEqual([]);

            const deepInventory = await discoverHappierServices({
                platform: 'linux',
                roots: [{ path: userRoot, scope: 'user' }],
                deep: true,
            });
            expect(deepInventory.services).toEqual([
                expect.objectContaining({
                    label: 'happier-daemon.preview.cloud',
                    verification: 'candidate',
                }),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
