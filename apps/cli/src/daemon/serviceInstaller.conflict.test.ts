import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

const happierRuntimeMocks = vi.hoisted(() => ({
    discoverHappierServicesMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/happierRuntime')>();
    return {
        ...actual,
        discoverHappierServices: happierRuntimeMocks.discoverHappierServicesMock,
    };
});

describe('daemon service installer conflict semantics', () => {
    it('refuses to add a competing daemon service by default', async () => {
        happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
            services: [
                {
                    id: 'systemd-user:happier-daemon.preview.other',
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.preview.other',
                    verification: 'verified',
                    ring: 'preview' satisfies PublicReleaseRingLabel,
                    instanceId: 'other',
                    scope: 'user',
                    definitionPath: '/tmp/.config/systemd/user/happier-daemon.preview.other.service',
                    executablePath: '/tmp/.happier/cli-preview/current/happier',
                    serverUrl: 'https://cloud.example.test',
                    publicServerUrl: 'https://cloud.example.test',
                    installed: true,
                    running: true,
                },
            ],
        });

        const { installDaemonService } = await import('./service/installer.js');

        await expect(installDaemonService({
            platform: 'linux',
            uid: 123,
            userHomeDir: '/tmp/home',
            happierHomeDir: '/tmp/home/.happier',
            channel: 'preview',
            instanceId: 'cloud',
            nodePath: '/usr/bin/node',
            entryPath: '/opt/happier/dist/index.mjs',
            serverUrl: 'https://cloud.example.test',
            runCommands: false,
        })).rejects.toThrow(/competing daemon services/i);
    });

    it('allows installing alongside existing services when --yes/add is selected', async () => {
        const root = await mkTempDir();
        try {
            const conflictPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.preview.other.service');
            await mkdir(join(root, '.config', 'systemd', 'user'), { recursive: true });
            await writeFile(conflictPath, '[Unit]\nDescription=Happier Daemon\n', 'utf8');

            happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
                services: [
                    {
                        id: 'systemd-user:happier-daemon.preview.other',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.preview.other',
                        verification: 'verified',
                        ring: 'preview' satisfies PublicReleaseRingLabel,
                        instanceId: 'other',
                        scope: 'user',
                        definitionPath: conflictPath,
                        executablePath: '/tmp/.happier/cli-preview/current/happier',
                        serverUrl: 'https://other.example.test',
                        publicServerUrl: 'https://other.example.test',
                        installed: true,
                        running: true,
                    },
                ],
            });

            const { installDaemonService } = await import('./service/installer.js');
            await installDaemonService({
                platform: 'linux',
                uid: 123,
                userHomeDir: root,
                happierHomeDir: join(root, '.happier'),
                channel: 'preview',
                instanceId: 'cloud',
                nodePath: '/usr/bin/node',
                entryPath: '/opt/happier/dist/index.mjs',
                serverUrl: 'https://cloud.example.test',
                strategy: 'add',
                runCommands: false,
            });

            expect(existsSync(conflictPath)).toBe(true);
            expect(existsSync(join(root, '.config', 'systemd', 'user', 'happier-daemon.preview.cloud.service'))).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('replaces verified services in the same ring when replace-ring is selected', async () => {
        const root = await mkTempDir();
        try {
            const conflictPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.preview.other.service');
            await mkdir(join(root, '.config', 'systemd', 'user'), { recursive: true });
            await writeFile(conflictPath, '[Unit]\nDescription=Happier Daemon\n', 'utf8');

            happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
                services: [
                    {
                        id: 'systemd-user:happier-daemon.preview.other',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.preview.other',
                        verification: 'verified',
                        ring: 'preview' satisfies PublicReleaseRingLabel,
                        instanceId: 'other',
                        scope: 'user',
                        definitionPath: conflictPath,
                        executablePath: '/tmp/.happier/cli-preview/current/happier',
                        serverUrl: 'https://cloud.example.test',
                        publicServerUrl: 'https://cloud.example.test',
                        installed: true,
                        running: true,
                    },
                ],
            });

            const { installDaemonService } = await import('./service/installer.js');
            await installDaemonService({
                platform: 'linux',
                uid: 123,
                userHomeDir: root,
                happierHomeDir: join(root, '.happier'),
                channel: 'preview',
                instanceId: 'cloud',
                nodePath: '/usr/bin/node',
                entryPath: '/opt/happier/dist/index.mjs',
                serverUrl: 'https://cloud.example.test',
                strategy: 'replace-ring',
                runCommands: false,
            });

            expect(existsSync(conflictPath)).toBe(false);
            expect(existsSync(join(root, '.config', 'systemd', 'user', 'happier-daemon.preview.cloud.service'))).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('maps dev-ring labels back to publicdev when removing conflicting services', async () => {
        const root = await mkTempDir();
        try {
            const conflictPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.dev.other.service');
            await mkdir(join(root, '.config', 'systemd', 'user'), { recursive: true });
            await writeFile(conflictPath, '[Unit]\nDescription=Happier Daemon\n', 'utf8');

            happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
                services: [
                    {
                        id: 'systemd-user:happier-daemon.dev.other',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.dev.other',
                        verification: 'verified',
                        ring: 'dev' satisfies PublicReleaseRingLabel,
                        instanceId: 'other',
                        scope: 'user',
                        definitionPath: conflictPath,
                        executablePath: '/tmp/.happier/cli-dev/current/happier',
                        serverUrl: 'https://cloud.example.test',
                        publicServerUrl: 'https://cloud.example.test',
                        installed: true,
                        running: true,
                    },
                ],
            });

            const { installDaemonService } = await import('./service/installer.js');
            await installDaemonService({
                platform: 'linux',
                uid: 123,
                userHomeDir: root,
                happierHomeDir: join(root, '.happier'),
                channel: 'publicdev',
                instanceId: 'cloud',
                nodePath: '/usr/bin/node',
                entryPath: '/opt/happier/dist/index.mjs',
                serverUrl: 'https://cloud.example.test',
                strategy: 'replace-ring',
                runCommands: false,
            });

            expect(existsSync(conflictPath)).toBe(false);
            expect(existsSync(join(root, '.config', 'systemd', 'user', 'happier-daemon.dev.cloud.service'))).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps the exact target idempotent when it already exists', async () => {
        const root = await mkTempDir();
        try {
            const targetPath = join(root, '.config', 'systemd', 'user', 'happier-daemon.preview.cloud.service');
            await mkdir(join(root, '.config', 'systemd', 'user'), { recursive: true });
            await writeFile(targetPath, '[Unit]\nDescription=Happier Daemon\n', 'utf8');

            happierRuntimeMocks.discoverHappierServicesMock.mockResolvedValue({
                services: [
                    {
                        id: 'systemd-user:happier-daemon.preview.cloud',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.preview.cloud',
                        verification: 'verified',
                        ring: 'preview' satisfies PublicReleaseRingLabel,
                        instanceId: 'cloud',
                        scope: 'user',
                        definitionPath: targetPath,
                        executablePath: '/tmp/.happier/cli-preview/current/happier',
                        serverUrl: 'https://cloud.example.test',
                        publicServerUrl: 'https://cloud.example.test',
                        installed: true,
                        running: true,
                    },
                    {
                        id: 'systemd-user:happier-daemon.preview.other',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.preview.other',
                        verification: 'verified',
                        ring: 'preview' satisfies PublicReleaseRingLabel,
                        instanceId: 'other',
                        scope: 'user',
                        definitionPath: join(root, '.config', 'systemd', 'user', 'happier-daemon.preview.other.service'),
                        executablePath: '/tmp/.happier/cli-preview/current/happier',
                        serverUrl: 'https://other.example.test',
                        publicServerUrl: 'https://other.example.test',
                        installed: true,
                        running: true,
                    },
                ],
            });

            const { installDaemonService } = await import('./service/installer.js');
            await expect(installDaemonService({
                platform: 'linux',
                uid: 123,
                userHomeDir: root,
                happierHomeDir: join(root, '.happier'),
                channel: 'preview',
                instanceId: 'cloud',
                nodePath: '/usr/bin/node',
                entryPath: '/opt/happier/dist/index.mjs',
                serverUrl: 'https://cloud.example.test',
                runCommands: false,
            })).resolves.toBeUndefined();

            expect(existsSync(targetPath)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

async function mkTempDir(): Promise<string> {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    return await mkdtemp(join(tmpdir(), 'happier-daemon-service-conflict-'));
}
