import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { spawnMock, fileSyncMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    fileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    spawn: (...args: unknown[]) => {
        spawnMock(...args);
        return {
            on(event: string, handler: (code: number) => void) {
                if (event === 'exit') {
                    queueMicrotask(() => handler(0));
                }
                return this;
            },
        };
    },
}));

vi.mock('tmp', () => ({
    default: {
        fileSync: (...args: unknown[]) => fileSyncMock(...args),
    },
}));

describe('migrate.light.new.ts', () => {
    let tmpDir = '';
    let originalArgv: string[] = [];

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-light-new-migrate-'));
        spawnMock.mockClear();
        fileSyncMock.mockReset().mockReturnValue({
            name: join(tmpDir, 'happy server light.sqlite'),
        });
        originalArgv = process.argv.slice();
        process.argv = [...originalArgv, '--name', 'add_test', '--force'];
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
        process.argv = originalArgv;
        vi.resetModules();
    });

    it('authors through the canonical migrator with an isolated database and passthrough flags', async () => {
        await import('./migrate.light.new');
        await vi.waitFor(() => expect(spawnMock.mock.calls.some(([, args]) =>
            Array.isArray(args) && args.includes('migrate') && args.includes('dev'))).toBe(true));

        const prismaCall = spawnMock.mock.calls.find(([, args]) => {
            const argv = Array.isArray(args) ? args : [];
            return argv.includes('migrate') && argv.includes('dev');
        });

        expect(prismaCall).toBeDefined();
        const env = (prismaCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        const expected = `file:${join(tmpDir, 'happy server light.sqlite')}?socket_timeout=30`;
        expect(env?.DATABASE_URL).toBe(expected);
        const require = createRequire(import.meta.url);
        expect(prismaCall?.[1]).toEqual([
            require.resolve('prisma-migrate-cli/build/index.js'),
            'migrate', 'dev', '--name', 'add_test', '--create-only', '--skip-generate', '--skip-seed', '--force',
            '--config', expect.any(String),
        ]);
    });
});
