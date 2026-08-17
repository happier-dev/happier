import { describe, expect, it } from 'vitest';

import {
    applyEnvOverridesToEnvText,
    appendPrismaSqliteConnectionParams,
    mergeSelfHostServerEnvText,
    renderPrismaCompatibleSqliteDatabaseUrl,
    renderSelfHostServerEnvText,
    resolvePrismaSqliteDatabaseUrlOptionsFromEnv,
    resolveConfiguredSelfHostBaseUrl,
} from './selfHostServerEnv.js';

type RenderSqliteUrl = (params: Readonly<{
    dbPath: string;
    platform: string;
    sqlite?: Readonly<{
        busyTimeoutMs?: number;
        connectionLimit?: number;
    }>;
}>) => string;

const SQLITE_URL_PROCESS_ENV_KEYS = [
    'HAPPIER_SQLITE_BUSY_TIMEOUT_MS',
    'HAPPY_SQLITE_BUSY_TIMEOUT_MS',
    'HAPPIER_SQLITE_CONNECTION_LIMIT',
    'HAPPY_SQLITE_CONNECTION_LIMIT',
] as const;

function withDefaultSqliteUrlProcessEnv<T>(run: () => T): T {
    const previousValues = new Map(
        SQLITE_URL_PROCESS_ENV_KEYS.map((key) => [key, process.env[key]] as const),
    );
    for (const key of SQLITE_URL_PROCESS_ENV_KEYS) {
        delete process.env[key];
    }
    try {
        return run();
    } finally {
        for (const key of SQLITE_URL_PROCESS_ENV_KEYS) {
            const previousValue = previousValues.get(key);
            if (typeof previousValue === 'string') {
                process.env[key] = previousValue;
            } else {
                delete process.env[key];
            }
        }
    }
}

describe('applyEnvOverridesToEnvText', () => {
    it('rejects env override keys with newlines', () => {
        expect(() => applyEnvOverridesToEnvText('PORT=3005\n', { 'BAD\nKEY': '1' })).toThrow(/env override/i);
    });

    it('rejects env override values with newlines', () => {
        expect(() => applyEnvOverridesToEnvText('PORT=3005\n', { PORT: '3005\nBAD=1' })).toThrow(/env override/i);
    });
});

describe('resolveConfiguredSelfHostBaseUrl', () => {
    it('prefers env overrides over the fallback baseUrl', () => {
        expect(resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: 'http://127.0.0.1:3005',
            envText: 'PORT=4010\nHAPPIER_SERVER_HOST=0.0.0.0\n',
        })).toBe('http://127.0.0.1:4010');
    });

    it('formats IPv6 hosts with brackets', () => {
        expect(resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: 'http://127.0.0.1:3005',
            envText: 'PORT=4010\nHAPPIER_SERVER_HOST=::1\n',
        })).toBe('http://[::1]:4010');
    });
});

describe('mergeSelfHostServerEnvText', () => {
    it('preserves user-owned overrides while regenerating managed runtime keys', () => {
        const merged = mergeSelfHostServerEnvText({
            baseEnvText: [
                'PORT=3005',
                'HAPPIER_SERVER_HOST=127.0.0.1',
                'DATABASE_URL=file:/new.sqlite',
                'NODE_PATH=/new/node_modules',
                'HAPPIER_SQLITE_MIGRATIONS_DIR=/new/migrations',
                'HAPPIER_SERVER_UI_DIR=/new/ui',
                '',
            ].join('\n'),
            existingEnvText: [
                'PORT=4010',
                'HAPPIER_PUBLIC_SERVER_URL=https://relay.example.test',
                'NODE_PATH=/old/node_modules',
                'HAPPIER_SQLITE_MIGRATIONS_DIR=/old/migrations',
                'HAPPIER_SERVER_UI_DIR=/old/ui',
                'CUSTOM_RUNTIME_FLAG=enabled',
                '',
            ].join('\n'),
        });

        expect(merged).toContain('PORT=4010');
        expect(merged).toContain('HAPPIER_PUBLIC_SERVER_URL=https://relay.example.test');
        expect(merged).toContain('CUSTOM_RUNTIME_FLAG=enabled');
        expect(merged).toContain('NODE_PATH=/new/node_modules');
        expect(merged).toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/new/migrations');
        expect(merged).toContain('HAPPIER_SERVER_UI_DIR=/new/ui');
        expect(merged).not.toContain('NODE_PATH=/old/node_modules');
        expect(merged).not.toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/old/migrations');
        expect(merged).not.toContain('HAPPIER_SERVER_UI_DIR=/old/ui');
    });

    it('rejects explicit UI-dir overrides owned by the relay runtime installer', () => {
        expect(() => mergeSelfHostServerEnvText({
            baseEnvText: [
                'PORT=3005',
                'HAPPIER_SERVER_UI_DIR=/managed/ui',
                '',
            ].join('\n'),
            overrides: {
                HAPPIER_SERVER_UI_DIR: '/tmp/volatile-ui',
            },
        })).toThrow(/owned by the relay runtime installer/i);

        expect(() => mergeSelfHostServerEnvText({
            baseEnvText: [
                'PORT=3005',
                'HAPPIER_SERVER_UI_DIR=/managed/ui',
                '',
            ].join('\n'),
            overrides: {
                HAPPIER_SERVER_LIGHT_UI_DIR: '/tmp/legacy-volatile-ui',
            },
        })).toThrow(/owned by the relay runtime installer/i);
    });

    it('continues to allow non-UI runtime overrides used by relay smoke tests', () => {
        const merged = mergeSelfHostServerEnvText({
            baseEnvText: [
                'PORT=3005',
                'HAPPIER_DB_PROVIDER=sqlite',
                'DATABASE_URL=file:/managed.sqlite',
                'HAPPIER_SERVER_UI_DIR=/managed/ui',
                '',
            ].join('\n'),
            overrides: {
                HAPPIER_DB_PROVIDER: 'postgres',
            },
        });

        expect(merged).toContain('HAPPIER_DB_PROVIDER=postgres');
    });
});

describe('renderSelfHostServerEnvText', () => {
    it('keeps sqlite auto-migrate enabled for darwin self-host runtimes even when the CLI runs under Bun', () => {
        const previousBun = (globalThis as { Bun?: unknown }).Bun;
        (globalThis as { Bun?: unknown }).Bun = {};

        try {
            const rendered = renderSelfHostServerEnvText({
                port: 3005,
                host: '127.0.0.1',
                dataDir: '/tmp/happier-data',
                filesDir: '/tmp/happier-data/files',
                dbDir: '/tmp/happier-data/pglite',
                serverBinDir: '/tmp/happier-server',
                platform: 'darwin',
                arch: 'arm64',
            });

            expect(rendered).toContain('HAPPIER_SQLITE_AUTO_MIGRATE=1');
        } finally {
            if (typeof previousBun === 'undefined') {
                delete (globalThis as { Bun?: unknown }).Bun;
            } else {
                (globalThis as { Bun?: unknown }).Bun = previousBun;
            }
        }
    });

    it('renders Windows sqlite DATABASE_URL in the Prisma-compatible drive-letter form', () => {
        const rendered = withDefaultSqliteUrlProcessEnv(() => renderSelfHostServerEnvText({
            port: 3005,
            host: '127.0.0.1',
            dataDir: 'C:\\Users\\me\\Happier QA\\self-host\\data',
            filesDir: 'C:\\Users\\me\\Happier QA\\self-host\\data\\files',
            dbDir: 'C:\\Users\\me\\Happier QA\\self-host\\data\\pglite',
            platform: 'win32',
        }));

        expect(rendered).toContain(
            'DATABASE_URL=file:C:/Users/me/Happier%20QA/self-host/data/happier-server-light.sqlite?socket_timeout=30&connection_limit=4',
        );
    });

    it('renders generated sqlite DATABASE_URL with the server-light bounded connection pool by default', () => {
        const rendered = withDefaultSqliteUrlProcessEnv(() => renderSelfHostServerEnvText({
            port: 3005,
            host: '127.0.0.1',
            dataDir: '/tmp/happier-data',
            filesDir: '/tmp/happier-data/files',
            dbDir: '/tmp/happier-data/pglite',
            platform: 'darwin',
        }));

        expect(rendered).toContain(
            'DATABASE_URL=file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=4',
        );
    });

    it('applies sqlite URL params from process env when rendering generated DATABASE_URL', () => {
        const previousBusyTimeout = process.env.HAPPIER_SQLITE_BUSY_TIMEOUT_MS;
        const previousConnectionLimit = process.env.HAPPIER_SQLITE_CONNECTION_LIMIT;
        process.env.HAPPIER_SQLITE_BUSY_TIMEOUT_MS = '500';
        process.env.HAPPIER_SQLITE_CONNECTION_LIMIT = '1';
        try {
            const rendered = renderSelfHostServerEnvText({
                port: 3005,
                host: '127.0.0.1',
                dataDir: '/tmp/happier-data',
                filesDir: '/tmp/happier-data/files',
                dbDir: '/tmp/happier-data/pglite',
                platform: 'darwin',
            });

            expect(rendered).toContain(
                'DATABASE_URL=file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=1&connection_limit=1',
            );
        } finally {
            if (typeof previousBusyTimeout === 'string') {
                process.env.HAPPIER_SQLITE_BUSY_TIMEOUT_MS = previousBusyTimeout;
            } else {
                delete process.env.HAPPIER_SQLITE_BUSY_TIMEOUT_MS;
            }
            if (typeof previousConnectionLimit === 'string') {
                process.env.HAPPIER_SQLITE_CONNECTION_LIMIT = previousConnectionLimit;
            } else {
                delete process.env.HAPPIER_SQLITE_CONNECTION_LIMIT;
            }
        }
    });
});

describe('renderPrismaCompatibleSqliteDatabaseUrl', () => {
    const render = renderPrismaCompatibleSqliteDatabaseUrl as RenderSqliteUrl;

    it('adds canonical socket_timeout without forcing a sqlite connection limit by default', () => {
        expect(render({ dbPath: '/tmp/happier-data/happier-server-light.sqlite', platform: 'linux' })).toBe(
            'file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=30',
        );
    });

    it('adds connection_limit only when helper options explicitly request it', () => {
        expect(render({
            dbPath: '/tmp/happier-data/happier-server-light.sqlite',
            platform: 'linux',
            sqlite: { connectionLimit: 1 },
        })).toBe('file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=30&connection_limit=1');
    });

    it('keeps Windows drive-letter URLs Prisma-compatible when appending query params', () => {
        expect(render({
            dbPath: 'C:\\Users\\me\\Happier QA\\self-host\\data\\happier-server-light.sqlite',
            platform: 'win32',
        })).toBe('file:C:/Users/me/Happier%20QA/self-host/data/happier-server-light.sqlite?socket_timeout=30');
    });

    it('converts busy timeout milliseconds to Prisma socket_timeout seconds without rounding down', () => {
        expect(render({
            dbPath: '/tmp/happier-data/happier-server-light.sqlite',
            platform: 'linux',
            sqlite: { busyTimeoutMs: 500 },
        })).toBe('file:///tmp/happier-data/happier-server-light.sqlite?socket_timeout=1');
    });

    it('omits socket_timeout and connection_limit when both are unconfigured', () => {
        expect(render({
            dbPath: '/tmp/happier-data/happier-server-light.sqlite',
            platform: 'linux',
            sqlite: { busyTimeoutMs: 0 },
        })).toBe('file:///tmp/happier-data/happier-server-light.sqlite');
    });

    it('treats literal question marks in dbPath as filesystem path characters', () => {
        expect(render({
            dbPath: '/tmp/happier?data/happier-server-light.sqlite',
            platform: 'linux',
        })).toBe('file:///tmp/happier%3Fdata/happier-server-light.sqlite?socket_timeout=30');
    });
});

describe('appendPrismaSqliteConnectionParams', () => {
    it('preserves existing query params and replaces sqlite connection params without duplicates', () => {
        expect(appendPrismaSqliteConnectionParams({
            databaseUrl: 'file:///tmp/happier-data/happier-server-light.sqlite?mode=rw&socket_timeout=5&connection_limit=9',
            busyTimeoutMs: 2500,
            connectionLimit: 1,
        })).toBe('file:///tmp/happier-data/happier-server-light.sqlite?mode=rw&socket_timeout=3&connection_limit=1');
    });
});

describe('resolvePrismaSqliteDatabaseUrlOptionsFromEnv', () => {
    it('resolves sqlite URL options from Happier env keys', () => {
        expect(resolvePrismaSqliteDatabaseUrlOptionsFromEnv({
            HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '500',
            HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
        })).toEqual({ busyTimeoutMs: 500, connectionLimit: 1 });
    });

    it('does not treat the PostgreSQL connection-limit env as a SQLite connection limit', () => {
        expect(resolvePrismaSqliteDatabaseUrlOptionsFromEnv({
            HAPPIER_DB_CONNECTION_LIMIT: '1',
        })).toEqual({ busyTimeoutMs: 30000, connectionLimit: undefined });
    });

    it('rejects invalid sqlite connection limits', () => {
        expect(() => resolvePrismaSqliteDatabaseUrlOptionsFromEnv({
            HAPPIER_SQLITE_CONNECTION_LIMIT: '0',
        })).toThrow(/HAPPIER_SQLITE_CONNECTION_LIMIT/i);
    });
});
