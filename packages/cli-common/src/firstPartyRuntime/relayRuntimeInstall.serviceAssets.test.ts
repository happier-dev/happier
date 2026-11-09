import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The packaged executable is a filesystem boundary; all service and install logic stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: ((...args: Parameters<typeof actual.readFile>) => {
        if (String(args[0]).endsWith('happier-service-launcher.exe')) {
            return Promise.reject(Object.assign(new Error('launcher fixture is unavailable'), { code: 'ENOENT' }));
        }
        return actual.readFile(...args);
    }) as typeof actual.readFile };
});

import { installOrUpdateRelayRuntimeLocal } from './relayRuntimeInstall.js';
import { resolveRelayRuntimeDefaults } from './relayRuntime.js';

describe('relay service launch asset admission', () => {
    it('rejects a missing task launcher before preparing or stopping the incumbent runtime', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-service-assets-'));
        try {
            const payloadRoot = join(homeDir, 'payload');
            await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
            await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n');
            const serverBinaryPath = join(payloadRoot, 'happier-server.exe');
            await writeFile(serverBinaryPath, 'new runtime');
            const defaults = resolveRelayRuntimeDefaults({ platform: 'win32', mode: 'user', channel: 'preview', homeDir });
            const incumbentBinary = join(defaults.installRoot, 'bin', 'happier-server.exe');
            await mkdir(join(defaults.installRoot, 'bin'), { recursive: true });
            await writeFile(incumbentBinary, 'incumbent runtime');
            let legacyCleanupStarted = false;
            await expect(installOrUpdateRelayRuntimeLocal({
                serverBinaryPath, channel: 'preview', mode: 'user', platform: 'win32', arch: 'x64', homeDir,
                runServiceCommands: false, skipHealthCheck: true,
                cleanupLegacyServiceBeforeInstall: async () => { legacyCleanupStarted = true; },
            })).rejects.toThrow(/launcher is unavailable/u);
            expect(legacyCleanupStarted).toBe(false);
            await expect(readFile(incumbentBinary, 'utf8')).resolves.toBe('incumbent runtime');
        } finally { await rm(homeDir, { recursive: true, force: true }); }
    });
});
