import { existsSync } from 'node:fs';
import { join, win32 as win32Path } from 'node:path';

const SELF_HOST_SERVER_ENV_MANAGED_KEYS = new Set<string>([
    'DATABASE_URL',
    'HAPPIER_DB_PROVIDER',
    'HAPPIER_FILES_BACKEND',
    'HAPPIER_SERVER_UI_DIR',
    'HAPPIER_SQLITE_AUTO_MIGRATE',
    'HAPPIER_SQLITE_MIGRATIONS_DIR',
    'HAPPIER_SERVER_LIGHT_DATA_DIR',
    'HAPPIER_SERVER_LIGHT_FILES_DIR',
    'HAPPIER_SERVER_LIGHT_DB_DIR',
    'HAPPIER_WEBAPP_URL',
    'HAPPY_WEBAPP_URL',
    'METRICS_ENABLED',
    'NODE_PATH',
    'PRISMA_CLIENT_ENGINE_TYPE',
    'PRISMA_QUERY_ENGINE_LIBRARY',
]);

export function renderSelfHostServerEnvTextFromResolvedValues(params: Readonly<{
    port: number;
    host: string;
    dataDir: string;
    filesDir: string;
    dbDir: string;
    databaseUrl: string;
    sqliteAutoMigrate: string;
    sqliteMigrationsDir: string;
    uiDir?: string;
    nodeModulesPath?: string;
    prismaEnginePath?: string;
}>): string {
    const uiDir = typeof params.uiDir === 'string' && params.uiDir.trim() ? params.uiDir.trim() : '';
    const nodeModulesPath = typeof params.nodeModulesPath === 'string' && params.nodeModulesPath.trim()
        ? params.nodeModulesPath.trim()
        : '';
    const prismaEnginePath = typeof params.prismaEnginePath === 'string' && params.prismaEnginePath.trim()
        ? params.prismaEnginePath.trim()
        : '';

    return [
        `PORT=${params.port}`,
        `HAPPIER_SERVER_HOST=${params.host}`,
        ...(uiDir ? [`HAPPIER_SERVER_UI_DIR=${uiDir}`] : []),
        'METRICS_ENABLED=false',
        'HAPPIER_DB_PROVIDER=sqlite',
        `DATABASE_URL=${params.databaseUrl}`,
        'HAPPIER_FILES_BACKEND=local',
        ...(nodeModulesPath ? [`NODE_PATH=${nodeModulesPath}`] : []),
        ...(prismaEnginePath
            ? [
                'PRISMA_CLIENT_ENGINE_TYPE=library',
                `PRISMA_QUERY_ENGINE_LIBRARY=${prismaEnginePath}`,
            ]
            : []),
        `HAPPIER_SQLITE_AUTO_MIGRATE=${params.sqliteAutoMigrate}`,
        `HAPPIER_SQLITE_MIGRATIONS_DIR=${params.sqliteMigrationsDir}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${params.dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${params.filesDir}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${params.dbDir}`,
        '',
    ].join('\n');
}

export function renderSelfHostServerEnvText(params: Readonly<{
    port: number;
    host: string;
    dataDir: string;
    filesDir: string;
    dbDir: string;
    uiDir?: string;
    serverBinDir?: string;
    arch?: string;
    platform?: NodeJS.Platform;
}>): string {
    const normalizedDataDir = String(params.dataDir ?? '').replace(/\/+$/, '') || String(params.dataDir ?? '');
    const platform = String(params.platform ?? '').trim() || process.platform;
    const arch = String(params.arch ?? '').trim() || process.arch;
    const uiDir = typeof params.uiDir === 'string' && params.uiDir.trim() ? params.uiDir.trim() : '';
    const serverBinDir = typeof params.serverBinDir === 'string' && params.serverBinDir.trim()
        ? params.serverBinDir.trim()
        : '';
    const hasBunRuntime = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined';
    const autoMigrateSqlite = platform === 'darwin' && hasBunRuntime ? '0' : '1';
    const migrationsDir = platform === 'win32'
        ? win32Path.join(String(params.dataDir ?? ''), 'migrations', 'sqlite')
        : `${normalizedDataDir}/migrations/sqlite`;
    const dbPath = platform === 'win32'
        ? win32Path.join(String(params.dataDir ?? ''), 'happier-server-light.sqlite')
        : `${normalizedDataDir}/happier-server-light.sqlite`;
    const databaseUrl = platform === 'win32'
        ? (() => {
            const normalized = String(dbPath).replaceAll('\\', '/');
            if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`;
            if (normalized.startsWith('//')) return `file:${normalized}`;
            return `file:///${normalized}`;
        })()
        : `file:${dbPath}`;

    const prismaEngineCandidates: string[] = [];
    if (serverBinDir && platform === 'darwin' && arch === 'arm64') {
        prismaEngineCandidates.push(
            join(serverBinDir, 'node_modules', '.prisma', 'client', 'libquery_engine-darwin-arm64.dylib.node'),
            join(serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-darwin-arm64.dylib.node'),
        );
    } else if (serverBinDir && platform === 'linux' && arch === 'arm64') {
        prismaEngineCandidates.push(
            join(serverBinDir, 'node_modules', '.prisma', 'client', 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'),
            join(serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'),
        );
    } else if (serverBinDir && platform === 'linux' && arch === 'x64') {
        prismaEngineCandidates.push(
            join(serverBinDir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'),
            join(serverBinDir, 'generated', 'sqlite-client', 'libquery_engine-debian-openssl-3.0.x.so.node'),
        );
    }
    const prismaEnginePath = prismaEngineCandidates.find((candidate) => existsSync(candidate)) || '';
    const nodeModulesPath = serverBinDir ? join(serverBinDir, 'node_modules') : '';

    return renderSelfHostServerEnvTextFromResolvedValues({
        port: params.port,
        host: params.host,
        dataDir: params.dataDir,
        filesDir: params.filesDir,
        dbDir: params.dbDir,
        databaseUrl,
        sqliteAutoMigrate: autoMigrateSqlite,
        sqliteMigrationsDir: migrationsDir,
        uiDir,
        nodeModulesPath,
        prismaEnginePath,
    });
}

export function parseEnvText(raw: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of String(raw ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1);
        if (!key) continue;
        env[key] = value;
    }
    return env;
}

export function resolveConfiguredSelfHostBaseUrl(params: Readonly<{ fallbackBaseUrl: string; envText: string }>): string {
    const raw = String(params.envText ?? '').trim();
    if (!raw) return params.fallbackBaseUrl;

    const parsed = parseEnvText(raw);
    const portRaw = typeof parsed.PORT === 'string' ? parsed.PORT.trim() : '';
    const port = portRaw ? Number.parseInt(portRaw, 10) : Number.NaN;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        return params.fallbackBaseUrl;
    }

    const hostRaw = typeof parsed.HAPPIER_SERVER_HOST === 'string' ? parsed.HAPPIER_SERVER_HOST.trim() : '';
    const host = hostRaw && hostRaw !== '0.0.0.0' ? hostRaw : '127.0.0.1';
    const authority = host.includes(':') && !host.startsWith('[') && !host.endsWith(']') ? `[${host}]` : host;
    return `http://${authority}:${port}`;
}

export function applyEnvOverridesToEnvText(
    envText: string,
    overrides: Readonly<Record<string, string>>,
): string {
    const pending = new Map<string, string>();
    for (const [rawKey, rawValue] of Object.entries(overrides ?? {})) {
        const key = String(rawKey ?? '').trim();
        const value = String(rawValue ?? '');
        if (!key) continue;
        assertValidEnvOverrideKey(key);
        assertValidEnvOverrideValue(value);
        pending.set(key, value);
    }
    const lines = String(envText ?? '').split('\n');
    const next: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
            next.push(line);
            continue;
        }
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        if (!key) {
            next.push(line);
            continue;
        }
        if (!pending.has(key)) {
            next.push(line);
            continue;
        }
        next.push(`${key}=${pending.get(key) ?? ''}`);
        pending.delete(key);
    }

    for (const [key, value] of pending.entries()) {
        if (!key) continue;
        next.push(`${key}=${value}`);
    }

    const rendered = next.join('\n');
    return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

export function mergeSelfHostServerEnvText(params: Readonly<{
    baseEnvText: string;
    existingEnvText?: string | null;
    overrides?: Readonly<Record<string, string>>;
}>): string {
    let merged = String(params.baseEnvText ?? '');
    const existing = parseEnvText(String(params.existingEnvText ?? ''));
    const preservedExistingEntries = Object.fromEntries(
        Object.entries(existing).filter(([key]) => !SELF_HOST_SERVER_ENV_MANAGED_KEYS.has(key)),
    );
    if (Object.keys(preservedExistingEntries).length > 0) {
        merged = applyEnvOverridesToEnvText(merged, preservedExistingEntries);
    }
    if (params.overrides && Object.keys(params.overrides).length > 0) {
        merged = applyEnvOverridesToEnvText(merged, params.overrides);
    }
    return merged;
}

function assertValidEnvOverrideKey(key: string): void {
    if (/[\r\n\0]/.test(key)) {
        throw new Error('Invalid env override: keys must be single-line.');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid env override: unsupported key "${key}".`);
    }
}

function assertValidEnvOverrideValue(value: string): void {
    if (/[\r\n\0]/.test(value)) {
        throw new Error('Invalid env override: values must be single-line.');
    }
}
