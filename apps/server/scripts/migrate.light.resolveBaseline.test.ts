import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { spawnMock, fixture } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    fixture: { migrationsDir: '' },
}));

// Stop at the OS process boundary: the real migration owner still selects and stages its CLI.
vi.mock('node:child_process', () => ({
    spawn: (...args: unknown[]) => {
        spawnMock(...args);
        return {
            on(event: string, handler: (code: number) => void) {
                if (event === 'exit') queueMicrotask(() => handler(0));
                return this;
            },
        };
    },
}));

// Give the script a disposable migration history without changing the shared checkout's cwd.
vi.mock('node:fs/promises', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...fs,
        readdir: (path: string, options: { withFileTypes: true }) =>
            fs.readdir(path === 'prisma/sqlite/migrations' ? fixture.migrationsDir : path, options),
    };
});

describe('migrate.light.resolveBaseline.ts', () => {
    let tmpDir = '';

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-light-baseline-'));
        fixture.migrationsDir = join(tmpDir, 'migrations');
        await mkdir(join(fixture.migrationsDir, '20260202000000_later'), { recursive: true });
        await mkdir(join(fixture.migrationsDir, '20260101000000_baseline'));
        await writeFile(join(fixture.migrationsDir, 'migration_lock.toml'), 'provider = "sqlite"');
        vi.stubEnv('HAPPY_SERVER_LIGHT_DATA_DIR', join(tmpDir, 'data'));
        vi.stubEnv('HAPPIER_SERVER_LIGHT_DATA_DIR', join(tmpDir, 'data'));
        vi.stubEnv('DATABASE_URL', `file:${join(tmpDir, 'existing.sqlite')}`);
        spawnMock.mockClear();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(tmpDir, { recursive: true, force: true });
        vi.resetModules();
    });

    it('resolves the first migration through the canonical migrator with the existing database environment', async () => {
        await import('./migrate.light.resolveBaseline');
        await vi.waitFor(() => expect(spawnMock.mock.calls.some(([, args]) =>
            Array.isArray(args) && args.includes('migrate') && args.includes('resolve'))).toBe(true));

        const prismaCall = spawnMock.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('migrate'));
        const require = createRequire(import.meta.url);
        expect(prismaCall?.[1]).toEqual([
            require.resolve('prisma-migrate-cli/build/index.js'),
            'migrate', 'resolve', '--applied', '20260101000000_baseline', '--config', expect.any(String),
        ]);
        const env = (prismaCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        expect(env?.DATABASE_URL).toBe(`file:${join(tmpDir, 'existing.sqlite')}`);
        expect(env?.HAPPIER_SERVER_LIGHT_DATA_DIR).toBe(join(tmpDir, 'data'));
    });
});
