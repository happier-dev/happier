import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, win32 as win32Path } from 'node:path';
import { homedir as defaultHomedir, tmpdir } from 'node:os';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { resolveLightSqliteDatabaseUrlOptionsFromEnv } from './sqliteConnectionConfig';

export type LightEnv = NodeJS.ProcessEnv;

function isBunfsHomeDir(path: string): boolean {
    return path === '/$bunfs' || path === '/$bunfs/root' || path.startsWith('/$bunfs/');
}

export function resolveLightDataDir(env: LightEnv, opts?: { homedir?: string }): string {
    const fromEnv = expandHomeDirPath((env.HAPPY_SERVER_LIGHT_DATA_DIR ?? env.HAPPIER_SERVER_LIGHT_DATA_DIR)?.trim() ?? '', env);
    if (fromEnv) {
        return fromEnv;
    }
    const home = String(opts?.homedir ?? resolveHomeDirFromEnvironment(env) ?? defaultHomedir()).trim();
    // Bun's in-memory "/$bunfs/root" homedir is ephemeral and not writable across runs.
    // Fall back to OS tmpdir for stable local light-server data during tests/dev.
    if (!home || isBunfsHomeDir(home)) {
        return join(tmpdir(), 'happier-server-light');
    }
    return join(home, '.happy', 'server-light');
}

export function resolveLightFilesDir(env: LightEnv, dataDir: string): string {
    const fromEnv = expandHomeDirPath((env.HAPPY_SERVER_LIGHT_FILES_DIR ?? env.HAPPIER_SERVER_LIGHT_FILES_DIR)?.trim() ?? '', env);
    if (fromEnv) {
        return fromEnv;
    }
    return join(dataDir, 'files');
}

export function resolveLightDatabaseDir(env: LightEnv, dataDir: string): string {
    const fromEnv = expandHomeDirPath((env.HAPPY_SERVER_LIGHT_DB_DIR ?? env.HAPPIER_SERVER_LIGHT_DB_DIR)?.trim() ?? '', env);
    if (fromEnv) {
        return fromEnv;
    }
    return join(dataDir, 'pglite');
}

export function resolveLightSqliteDatabaseUrl(
    dataDir: string,
    platform: NodeJS.Platform = process.platform,
    env: LightEnv = process.env,
): string {
    const trimmed = String(dataDir ?? '').trim();
    if (!trimmed) {
        return '';
    }
    const dbPath = platform === 'win32'
        ? win32Path.join(trimmed, 'happier-server-light.sqlite')
        : join(trimmed, 'happier-server-light.sqlite');
    return renderPrismaCompatibleSqliteDatabaseUrl({
        dbPath,
        platform,
        sqlite: resolveLightSqliteDatabaseUrlOptionsFromEnv(env),
    });
}

export function resolveLightPublicUrl(env: LightEnv): string {
    const fromEnv = env.PUBLIC_URL?.trim();
    if (fromEnv) {
        return fromEnv.replace(/\/+$/, '');
    }
    const parsed = env.PORT ? parseInt(env.PORT, 10) : NaN;
    const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3005;
    return `http://localhost:${port}`;
}

export function applyLightDefaultEnv(env: LightEnv, opts?: { homedir?: string }): void {
    const dataDir = resolveLightDataDir(env, opts);
    const filesDir = resolveLightFilesDir(env, dataDir);
    const dbDir = resolveLightDatabaseDir(env, dataDir);

    env.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    env.HAPPY_SERVER_LIGHT_FILES_DIR = filesDir;
    env.HAPPY_SERVER_LIGHT_DB_DIR = dbDir;
    env.HAPPIER_SERVER_LIGHT_DATA_DIR ??= dataDir;
    env.HAPPIER_SERVER_LIGHT_FILES_DIR ??= filesDir;
    env.HAPPIER_SERVER_LIGHT_DB_DIR ??= dbDir;

    env.PUBLIC_URL = resolveLightPublicUrl(env);
}

function firstNonEmpty(...values: Array<string | undefined>): string {
    for (const value of values) {
        const normalized = String(value ?? '').trim();
        if (normalized) return normalized;
    }
    return '';
}

export function resolvePackagedLightSqliteMigrationsDir(executablePath: string = process.execPath): string {
    const candidate = join(dirname(executablePath), 'prisma', 'sqlite', 'migrations');
    return existsSync(candidate) ? candidate : '';
}

export function applyPackagedLightRuntimeSqliteDefaults(
    env: LightEnv,
    opts?: Readonly<{ executablePath?: string }>,
): void {
    const dataDir = firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DATA_DIR, env.HAPPY_SERVER_LIGHT_DATA_DIR);
    if (!dataDir) return;

    env.DATABASE_URL = firstNonEmpty(env.DATABASE_URL, resolveLightSqliteDatabaseUrl(dataDir, process.platform, env));

    const packagedMigrationsDir = resolvePackagedLightSqliteMigrationsDir(opts?.executablePath);
    if (!packagedMigrationsDir) return;

    env.HAPPIER_SQLITE_AUTO_MIGRATE = firstNonEmpty(
        env.HAPPIER_SQLITE_AUTO_MIGRATE,
        env.HAPPY_SQLITE_AUTO_MIGRATE,
        '1',
    );
    env.HAPPIER_SQLITE_MIGRATIONS_DIR = firstNonEmpty(
        env.HAPPIER_SQLITE_MIGRATIONS_DIR,
        env.HAPPY_SQLITE_MIGRATIONS_DIR,
        packagedMigrationsDir,
    );
}

export async function ensureHandyMasterSecret(env: LightEnv, opts?: { dataDir?: string; homedir?: string }): Promise<void> {
    const dataDir = opts?.dataDir ?? resolveLightDataDir(env, { homedir: opts?.homedir });
    await mkdir(dataDir, { recursive: true });

    if (env.HANDY_MASTER_SECRET && env.HANDY_MASTER_SECRET.trim()) {
        return;
    }
    const secretPath = join(dataDir, 'handy-master-secret.txt');

    try {
        const existing = (await readFile(secretPath, 'utf-8')).trim();
        if (existing) {
            env.HANDY_MASTER_SECRET = existing;
            return;
        }
    } catch {
        // ignore - will create below
    }

    await mkdir(dirname(secretPath), { recursive: true });
    const generated = randomBytes(32).toString('base64url');
    try {
        await writeFile(secretPath, generated, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        env.HANDY_MASTER_SECRET = generated;
        return;
    } catch (err: any) {
        if (err?.code !== 'EEXIST') {
            throw err;
        }
    }

    // Another process likely created the file while we were racing to initialize it.
    const existing = (await readFile(secretPath, 'utf-8')).trim();
    if (!existing) {
        throw new Error(`handy-master-secret.txt exists but is empty: ${secretPath}`);
    }
    env.HANDY_MASTER_SECRET = existing;
}
