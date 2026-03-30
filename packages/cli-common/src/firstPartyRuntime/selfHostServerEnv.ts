import { existsSync } from 'node:fs';
import { join, win32 as win32Path } from 'node:path';

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

    return [
        `PORT=${params.port}`,
        `HAPPIER_SERVER_HOST=${params.host}`,
        ...(uiDir ? [`HAPPIER_SERVER_UI_DIR=${uiDir}`] : []),
        'METRICS_ENABLED=false',
        'HAPPIER_DB_PROVIDER=sqlite',
        `DATABASE_URL=${databaseUrl}`,
        'HAPPIER_FILES_BACKEND=local',
        ...(nodeModulesPath ? [`NODE_PATH=${nodeModulesPath}`] : []),
        ...(prismaEnginePath
            ? [
                'PRISMA_CLIENT_ENGINE_TYPE=library',
                `PRISMA_QUERY_ENGINE_LIBRARY=${prismaEnginePath}`,
            ]
            : []),
        `HAPPIER_SQLITE_AUTO_MIGRATE=${autoMigrateSqlite}`,
        `HAPPIER_SQLITE_MIGRATIONS_DIR=${migrationsDir}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${params.dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${params.filesDir}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${params.dbDir}`,
        '',
    ].join('\n');
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

export function applyEnvOverridesToEnvText(
    envText: string,
    overrides: Readonly<Record<string, string>>,
): string {
    const pending = new Map(Object.entries(overrides ?? {}).map(([key, value]) => [String(key), String(value)]));
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

