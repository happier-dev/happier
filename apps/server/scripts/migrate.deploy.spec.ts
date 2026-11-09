import { describe, expect, it } from 'vitest';
import { resolveMigrationDeployScript } from './migrate.deploy';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MODULE_IMPORT_TIMEOUT_MS = 60_000;

describe('SQLite migration module initialization', () => {
    it.each(['default', 'happier-source'])(
        'loads the migration entry in a fresh process with %s package resolution',
        async (condition) => {
            // Import only: exercise the real migration graph without opening a database.
            // Vitest's warmed module graph otherwise hides initialization-order failures.
            const { stdout } = await execFileAsync(process.execPath, [
                ...(condition === 'happier-source' ? ['--conditions=happier-source'] : []),
                '--import', 'tsx', '--input-type=module', '--eval',
                'await import("./scripts/migrate.sqlite.deploy.ts"); console.log("MIGRATION_ENTRY_IMPORT_READY");',
            ], {
                cwd: resolve(__dirname, '..'),
                encoding: 'utf8',
                timeout: MODULE_IMPORT_TIMEOUT_MS,
            });
            expect(stdout.trim()).toBe('MIGRATION_ENTRY_IMPORT_READY');
        },
        MODULE_IMPORT_TIMEOUT_MS + 5_000,
    );
});

describe('resolveMigrationDeployScript', () => {
    it.each([
        ['postgres', 'migrate:full:deploy'],
        ['postgresql', 'migrate:full:deploy'],
        ['mysql', 'migrate:mysql:deploy'],
        ['pglite', 'migrate:light:deploy'],
        ['sqlite', 'migrate:sqlite:deploy'],
    ])('maps %s to the canonical migration implementation', (provider, script) => {
        expect(resolveMigrationDeployScript({ HAPPIER_DB_PROVIDER: provider })).toBe(script);
    });

    it('defaults to Postgres for direct full-runtime use', () => {
        expect(resolveMigrationDeployScript({})).toBe('migrate:full:deploy');
    });

    it('rejects an explicit unsupported provider instead of migrating the fallback database', () => {
        expect(() => resolveMigrationDeployScript({ HAPPIER_DB_PROVIDER: 'postgress' })).toThrow(/Unsupported/);
    });
});

describe('migration child environment', () => {
    it.each([
        ['postgres', 'direct-connection', true],
        ['postgresql', ' direct-connection ', true],
        ['postgres', undefined, false],
        ['postgres', '', false],
        ['postgres', '  ', false],
        ['mysql', 'direct-connection', false],
        ['sqlite', 'direct-connection', false],
        ['pglite', 'direct-connection', false],
    ])('selects the migration connection without mutating runtime env (%s, case %#)', async (provider, directUrl, usesDirect) => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-migration-env-'));
        try {
            const yarnBoundary = join(dir, 'yarn.cjs');
            // The process boundary reports only comparisons, never connection values.
            await writeFile(yarnBoundary, `process.stdout.write(JSON.stringify({
                direct: process.env.DATABASE_URL === 'direct-connection',
                pooled: process.env.DATABASE_URL === 'runtime-connection',
                script: process.argv.at(-1),
            }));`);
            const env = {
                ...process.env,
                HAPPIER_DB_PROVIDER: provider,
                DATABASE_URL: 'runtime-connection',
                DIRECT_URL: directUrl,
                npm_execpath: yarnBoundary,
            };
            const result = spawnSync(process.execPath, ['--import', 'tsx', './scripts/migrate.deploy.ts'], {
                cwd: resolve(__dirname, '..'), env, encoding: 'utf8',
            });
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({
                direct: usesDirect,
                pooled: !usesDirect,
                script: resolveMigrationDeployScript(env),
            });
            expect(env.DATABASE_URL === 'runtime-connection').toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
