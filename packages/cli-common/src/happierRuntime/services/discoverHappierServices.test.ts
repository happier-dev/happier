import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderSystemdServiceUnit } from '../../service/systemd.js';

import { discoverHappierServices } from './discoverHappierServices.js';

describe('discoverHappierServices', () => {
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
