import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
            events.push(`rename:${String(args[0])}->${String(args[1])}`);
            return await actual.rename(...args);
        }),
        rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
            if (String(args[0] ?? '').endsWith('happier-relay-runtime.service')) {
                events.push('rm-service-definition');
            }
            return await actual.rm(...args);
        }),
    };
});

vi.mock('../service/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../service/index.js')>();

    return {
        ...actual,
        resolveServiceBackend: vi.fn(() => 'systemd-user'),
        buildServiceDefinition: vi.fn(() => ({
            path: '/tmp/happier-relay-runtime.service',
            contents: '[Service]\n',
        })),
        planServiceAction: vi.fn((params: { action: string; label?: string }) => ({
            __action: params.action,
            __label: String(params.label ?? ''),
            writes: [],
            commands: [],
        })),
        applyServicePlan: vi.fn(async (plan: { __action?: string; __label?: string }) => {
            events.push(`${String(plan.__action ?? 'unknown')}:${String(plan.__label ?? '')}`);
        }),
    };
});

describe('installOrUpdateRelayRuntimeLocal legacy root migration', () => {
    it('fails before migrating the legacy install root when the new server binary is missing', async () => {
        events.length = 0;

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-runtime-missing-binary-'));
        try {
            const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');

            const stableDefaults = resolveRelayRuntimeDefaults({
                platform: 'linux',
                mode: 'user',
                channel: 'stable',
                homeDir,
            });
            const previewDefaults = resolveRelayRuntimeDefaults({
                platform: 'linux',
                mode: 'user',
                channel: 'preview',
                homeDir,
            });

            await mkdir(stableDefaults.installRoot, { recursive: true });
            await writeFile(join(stableDefaults.installRoot, 'legacy.txt'), 'legacy-root\n', 'utf8');
            expect(existsSync(previewDefaults.installRoot)).toBe(false);

            const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
            await expect(installOrUpdateRelayRuntimeLocal({
                serverBinaryPath: join(homeDir, 'missing', 'happier-server'),
                channel: 'preview',
                mode: 'user',
                platform: 'linux',
                arch: 'arm64',
                homeDir,
                runServiceCommands: true,
                skipHealthCheck: true,
            })).rejects.toThrow(/server binary not found/);

            expect(events).not.toContain(`rename:${stableDefaults.installRoot}->${previewDefaults.installRoot}`);
            expect(existsSync(join(stableDefaults.installRoot, 'legacy.txt'))).toBe(true);
            expect(existsSync(previewDefaults.installRoot)).toBe(false);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 60_000);

    it('attempts to stop both legacy and canonical service names before renaming the legacy install root', async () => {
        events.length = 0;

        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-runtime-legacy-root-migration-'));
        try {
            const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');

            const stableDefaults = resolveRelayRuntimeDefaults({
                platform: 'linux',
                mode: 'user',
                channel: 'stable',
                homeDir,
            });
            const previewDefaults = resolveRelayRuntimeDefaults({
                platform: 'linux',
                mode: 'user',
                channel: 'preview',
                homeDir,
            });

            await mkdir(stableDefaults.installRoot, { recursive: true });
            await writeFile(join(stableDefaults.installRoot, 'legacy.txt'), 'legacy-root\n', 'utf8');
            expect(existsSync(join(stableDefaults.installRoot, 'self-host-state.json'))).toBe(false);
            expect(existsSync(previewDefaults.installRoot)).toBe(false);

            const payloadRoot = join(homeDir, 'payload');
            const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
            await mkdir(migrationsSourceDir, { recursive: true });
            await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
            const serverBinaryPath = join(payloadRoot, 'happier-server');
            await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

            const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
            await installOrUpdateRelayRuntimeLocal({
                serverBinaryPath,
                channel: 'preview',
                mode: 'user',
                platform: 'linux',
                arch: 'arm64',
                homeDir,
                runServiceCommands: true,
                skipHealthCheck: true,
            });

            const renameIndex = events.indexOf(`rename:${stableDefaults.installRoot}->${previewDefaults.installRoot}`);
            expect(renameIndex).toBeGreaterThanOrEqual(0);
            const preRenameEvents = events.slice(0, renameIndex);
            expect(preRenameEvents).toContain('stop:happier-server');
            expect(preRenameEvents).toContain('stop:happier-server-preview');
            expect(events.slice(renameIndex + 1)).toContain('uninstall:happier-server');
            expect(events.slice(renameIndex + 1)).toContain('rm-service-definition');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    }, 60_000);
});
