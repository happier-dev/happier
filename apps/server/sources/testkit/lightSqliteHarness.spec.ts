import childProcess from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { resolveSqliteDatabaseFilePath } from '@/flavors/light/sqliteMigrations';
import { db } from '@/storage/db';
import { snapshotEnv, restoreEnv } from './env';
import { createLightSqliteHarness } from './lightSqliteHarness';

describe('SQLite harness migration work', () => {
    it('migrates once across isolated module loads while copying independent databases', async () => {
        const environment = snapshotEnv();
        const root = await mkdtemp(join(tmpdir(), 'happier-light-template-contract-'));
        process.env.HAPPIER_E2E_SERVER_LIGHT_TEMPLATE_CACHE_DIR = join(root, 'templates');
        const spawn = childProcess.spawnSync;
        let migrations = 0;
        // The migration subprocess is the OS boundary. Its fixture has only a
        // sentinel table; all cache, isolation and Prisma lifecycle logic is real.
        const deploy = vi.spyOn(childProcess, 'spawnSync').mockImplementation((command, args, options) => {
            if (!Array.isArray(args) || !args.includes('migrate:sqlite:deploy')) {
                return spawn(command, args, options);
            }
            migrations += 1;
            const path = resolveSqliteDatabaseFilePath(String(options?.env?.DATABASE_URL ?? ''));
            if (!path) throw new Error('Missing disposable migration database');
            const database = new DatabaseSync(path);
            try { database.exec('CREATE TABLE HarnessValue (value TEXT NOT NULL)'); }
            finally { database.close(); }
            return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null };
        });
        syncBuiltinESMExports();
        let close: (() => Promise<void>) | undefined;
        try {
            const first = await createLightSqliteHarness({ tempDirPrefix: 'happier-light-template-first-' });
            close = first.close;
            await db.$executeRawUnsafe("INSERT INTO HarnessValue (value) VALUES ('first-only')");
            await first.close();
            close = undefined;
            expect(migrations).toBe(1);

            // Vitest isolates modules per file. Re-importing proves reuse is
            // owned by the template on disk rather than a module-local promise.
            vi.resetModules();
            const next = await import('./lightSqliteHarness');
            const storage = await import('@/storage/db');
            const second = await next.createLightSqliteHarness({ tempDirPrefix: 'happier-light-template-second-' });
            close = second.close;
            expect(await storage.db.$queryRawUnsafe('SELECT value FROM HarnessValue')).toEqual([]);
            expect(second.dbPath).not.toBe(first.dbPath);
            expect(migrations, 'later test files must apply zero migrations').toBe(1);
        } finally {
            await close?.();
            deploy.mockRestore();
            syncBuiltinESMExports();
            restoreEnv(environment);
            await rm(root, { recursive: true, force: true });
        }
    });
});
