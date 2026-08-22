import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { openSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
    createPluginDaemonDatabaseOwner,
    createStablePluginDaemonDatabaseHost,
} from './daemonDatabase';
import {
    createDaemonDatabaseWorkerClient,
    type DaemonDatabaseWorkerAllRequestOptions,
} from './daemonDatabaseWorker';
import { createStablePluginStorageService } from './storage';

const observedWorkerResponses = vi.hoisted((): unknown[] => []);

vi.mock('@/utils/spawnHappyCLI', async () => {
    const [{ spawn }, { createRequire }, { dirname, join }, { pathToFileURL }] = await Promise.all([
        import('node:child_process'),
        import('node:module'),
        import('node:path'),
        import('node:url'),
    ]);
    const require = createRequire(import.meta.url);
    const tsxPackageJson = require.resolve('tsx/package.json');
    const tsxHook = join(dirname(tsxPackageJson), 'dist', 'esm', 'index.mjs');
    const workerEntryUrl = pathToFileURL(
        join(process.cwd(), 'src', 'plugins', 'runtime', 'context', 'daemonDatabaseWorkerEntry.ts'),
    ).href;
    return {
        // The production client uses the binary-safe Happier CLI child. This test
        // substitutes only that external launch boundary with the same real SQLite
        // worker entry under TSX, because the unit harness intentionally lacks the
        // full generated bundled-plugin dist closure needed by CLI index.ts.
        spawnHappyCLI: vi.fn(() => {
            const child = spawn(process.execPath, [
                '--no-warnings',
                '--no-deprecation',
                '--import',
                tsxHook,
                '--input-type=module',
                '--eval',
                `import(${JSON.stringify(workerEntryUrl)}).then(({ runDaemonDatabaseWorkerChild }) => runDaemonDatabaseWorkerChild())`,
            ], {
                stdio: ['pipe', 'pipe', 'inherit'],
                env: {
                    ...process.env,
                    TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json'),
                },
            });
            let buffered = '';
            child.stdout?.on('data', (chunk: Buffer) => {
                buffered += chunk.toString('utf8');
                while (true) {
                    const newline = buffered.indexOf('\n');
                    if (newline < 0) return;
                    const line = buffered.slice(0, newline);
                    buffered = buffered.slice(newline + 1);
                    if (!line.trim()) continue;
                    try {
                        observedWorkerResponses.push(JSON.parse(line) as unknown);
                    } catch {
                        // The production client owns protocol validation; this
                        // boundary probe only records complete JSON frames.
                    }
                }
            });
            return child;
        }),
    };
});

async function makeHappyHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-plugin-daemon-database-'));
}

function observedRowsResponseCount(): number {
    return observedWorkerResponses.filter((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const response = value as Readonly<{ ok?: unknown; result?: unknown }>;
        if (response.ok !== true || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
            return false;
        }
        return (response.result as Readonly<{ kind?: unknown }>).kind === 'rows';
    }).length;
}

describe('plugin daemon database owner', () => {
    it('stops at row and encoded-byte result overages before evaluating later SQLite rows', async () => {
        const happyHomeDir = await makeHappyHome();
        const worker = createDaemonDatabaseWorkerClient(join(happyHomeDir, 'bounded-results.sqlite'));
        // Keep this at the real child-process boundary so a parent-only
        // post-IPC check cannot satisfy the regression.
        const workerResultLimits = (maximumResultRows: number, maximumResultBytes: number): DaemonDatabaseWorkerAllRequestOptions => Object.freeze({
            resultLimits: Object.freeze({ maximumResultRows, maximumResultBytes }),
        });
        observedWorkerResponses.length = 0;
        try {
            const lease = await worker.acquire();
            await lease.exec(`
                CREATE TABLE records (value TEXT NOT NULL);
                INSERT INTO records (value) VALUES ('first');
                INSERT INTO records (value) VALUES ('second');
            `);

            const rowsBeforeRowLimit = observedRowsResponseCount();
            await expect(lease.all(
                'SELECT value FROM records ORDER BY value',
                [],
                workerResultLimits(1, 1024),
            )).rejects.toMatchObject({
                code: 'daemon_database_result_too_large',
            });
            expect(observedRowsResponseCount()).toBe(rowsBeforeRowLimit);

            const rowsBeforeByteLimit = observedRowsResponseCount();
            await expect(lease.all(
                "SELECT 'result-that-cannot-fit' AS value",
                [],
                workerResultLimits(100, 1),
            )).rejects.toMatchObject({
                code: 'daemon_database_result_too_large',
            });
            expect(observedRowsResponseCount()).toBe(rowsBeforeByteLimit);

            // The later expression becomes a SQLite error if the worker reads it.
            // A post-hoc `.all()` cap would evaluate it before rejecting the result;
            // iterator-based collection must reject on the preceding row instead.
            await lease.exec(`
                CREATE TABLE row_limit_tripwire (value TEXT NOT NULL);
                INSERT INTO row_limit_tripwire (value) VALUES ('first');
                INSERT INTO row_limit_tripwire (value) VALUES ('second');
                INSERT INTO row_limit_tripwire (value) VALUES ('tripwire');

                CREATE TABLE byte_limit_tripwire (value TEXT NOT NULL);
                INSERT INTO byte_limit_tripwire (value) VALUES ('result-that-cannot-fit');
                INSERT INTO byte_limit_tripwire (value) VALUES ('tripwire');
            `);
            await expect(lease.all(
                `
                    SELECT CASE
                        WHEN rowid = 3 THEN abs(-9223372036854775808)
                        ELSE value
                    END AS value
                    FROM row_limit_tripwire
                `,
                [],
                workerResultLimits(1, 1024),
            )).rejects.toMatchObject({
                code: 'daemon_database_result_too_large',
            });
            await expect(lease.all(
                `
                    SELECT CASE
                        WHEN rowid = 2 THEN abs(-9223372036854775808)
                        ELSE value
                    END AS value
                    FROM byte_limit_tripwire
                `,
                [],
                workerResultLimits(100, 1),
            )).rejects.toMatchObject({
                code: 'daemon_database_result_too_large',
            });
            await expect(lease.all(
                'SELECT value FROM records ORDER BY value LIMIT 1',
                [],
                workerResultLimits(1, 1024),
            )).resolves.toEqual([{ value: 'first' }]);
        } finally {
            await worker.close();
            observedWorkerResponses.length = 0;
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('reopens the host migration ledger without applying public result caps to it', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const limits = {
            maximumDatabaseBytes: 1_048_576,
            maximumInputBytes: 16_384,
            maximumResultBytes: 16_384,
            maximumResultRows: 1,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        } as const;
        const createOwner = () => createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits,
            declarations: [{
                id: 'main',
                migrations: [
                    { version: 1, id: 'create-records' },
                    { version: 2, id: 'add-label' },
                ],
                incumbentQueryFixtureId: 'records-v2',
            }],
        });
        const open = async (owner: ReturnType<typeof createPluginDaemonDatabaseOwner>) => await owner.storage.database('main', {
            migrations: [
                {
                    version: 1,
                    id: 'create-records',
                    up: async (transaction) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                },
                {
                    version: 2,
                    id: 'add-label',
                    up: async (transaction) => {
                        await transaction.execute('ALTER TABLE records ADD COLUMN label TEXT');
                    },
                },
            ],
            incumbentQueryFixture: {
                id: 'records-v2',
                run: async (transaction) => {
                    await transaction.query('SELECT value FROM records');
                },
            },
        });
        const first = createOwner();
        let second: ReturnType<typeof createPluginDaemonDatabaseOwner> | null = null;
        try {
            await open(first);
            await first.close();

            second = createOwner();
            await expect(open(second)).resolves.toMatchObject({
                query: expect.any(Function),
            });
        } finally {
            await second?.close();
            await first.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('keeps declared databases unavailable without an injected measured limits policy', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const controller = new AbortController();
        let migrationRuns = 0;
        const runtime = Object.freeze({
            index: Object.freeze({
                migrations: Object.freeze([Object.freeze({
                    version: 1,
                    id: 'create-index',
                    up: async () => { migrationRuns += 1; },
                })]),
                incumbentQueryFixture: Object.freeze({
                    id: 'index-v1',
                    run: async () => undefined,
                }),
            }),
        });
        const host = createStablePluginDaemonDatabaseHost({ paths });
        try {
            await host.prepare({
                pluginId: 'acme.indexer',
                generation: '7',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                declarations: [{
                    id: 'index',
                    migrations: [{ version: 1, id: 'create-index' }],
                    incumbentQueryFixtureId: 'index-v1',
                }],
                runtime,
            });

            expect(migrationRuns).toBe(0);
            expect(host.readCapability('acme.indexer')).toEqual({
                status: 'unavailable',
                code: 'daemon_database_policy_unavailable',
            });
            await expect(host.bind({
                pluginId: 'acme.indexer',
                generation: '7',
                signal: controller.signal,
                isGenerationCurrent: () => true,
            }).database('index', runtime.index)).rejects.toMatchObject({
                code: 'daemon_database_policy_unavailable',
            });
        } finally {
            await host.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('prepares every declared database deterministically, binds it through storage.daemon, and closes it at retirement', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const controller = new AbortController();
        const migrationOrder: string[] = [];
        const limits = {
            maximumDatabaseBytes: 1_048_576,
            maximumInputBytes: 16_384,
            maximumResultBytes: 16_384,
            maximumResultRows: 100,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        } as const;
        // The test intentionally uses ordinary runtime callbacks rather than a
        // host-private fixture: this is the consumed storage.daemon path.
        const runtime = Object.freeze({
            alpha: Object.freeze({
                migrations: Object.freeze([Object.freeze({
                    version: 1,
                    id: 'create-alpha',
                    up: async (transaction: { execute(sql: string): Promise<unknown> }) => {
                        migrationOrder.push('alpha');
                        await transaction.execute('CREATE TABLE entries (value TEXT NOT NULL)');
                    },
                })]),
                incumbentQueryFixture: Object.freeze({
                    id: 'alpha-v1',
                    run: async () => undefined,
                }),
            }),
            beta: Object.freeze({
                migrations: Object.freeze([Object.freeze({
                    version: 1,
                    id: 'create-beta',
                    up: async (transaction: { execute(sql: string): Promise<unknown> }) => {
                        migrationOrder.push('beta');
                        await transaction.execute('CREATE TABLE entries (value TEXT NOT NULL)');
                    },
                })]),
                incumbentQueryFixture: Object.freeze({
                    id: 'beta-v1',
                    run: async () => undefined,
                }),
            }),
        });
        const host = createStablePluginDaemonDatabaseHost({
            paths,
            daemonDatabaseLimits: Object.freeze({
                protocolMaximumDatabaseBytes: limits.maximumDatabaseBytes,
                resolvePluginLimits: (pluginId: string) => (
                    pluginId === 'acme.indexer' ? limits : null
                ),
            }),
        });
        try {
            await host.prepare({
                pluginId: 'acme.indexer',
                generation: '7',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                declarations: [
                    { id: 'beta', migrations: [{ version: 1, id: 'create-beta' }], incumbentQueryFixtureId: 'beta-v1' },
                    { id: 'alpha', migrations: [{ version: 1, id: 'create-alpha' }], incumbentQueryFixtureId: 'alpha-v1' },
                ],
                runtime,
            });
            expect(migrationOrder).toEqual(['alpha', 'beta']);
            expect(host.readCapability('acme.indexer')).toEqual({
                status: 'available',
                protocolMaximumDatabaseBytes: limits.maximumDatabaseBytes,
                limits,
            });

            const storage = createStablePluginStorageService({
                pluginId: 'acme.indexer',
                paths,
                generation: '7',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                daemonDatabase: host,
            });
            await storage.daemon.set('retained-key', 'retained-value');
            await expect(storage.daemon.get('retained-key')).resolves.toBe('retained-value');

            const database = await storage.daemon.database('alpha', runtime.alpha);
            await database.execute('INSERT INTO entries (value) VALUES (?)', ['retained']);
            await expect(database.query('SELECT value FROM entries')).resolves.toEqual([
                { value: 'retained' },
            ]);

            await host.close();
            await expect(database.query('SELECT value FROM entries')).rejects.toMatchObject({
                code: 'daemon_database_closed',
            });
        } finally {
            await host.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('enforces one aggregate plugin byte budget across declared databases while retaining per-file page limits', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const limits = {
            maximumDatabaseBytes: 64 * 1024,
            maximumInputBytes: 64 * 1024,
            maximumResultBytes: 16 * 1024,
            maximumResultRows: 100,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        } as const;
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits,
            declarations: [
                { id: 'alpha', migrations: [{ version: 1, id: 'create-alpha' }], incumbentQueryFixtureId: 'alpha-v1' },
                { id: 'beta', migrations: [{ version: 1, id: 'create-beta' }], incumbentQueryFixtureId: 'beta-v1' },
            ],
        });
        const runtime = Object.freeze({
            alpha: Object.freeze({
                migrations: Object.freeze([Object.freeze({
                    version: 1,
                    id: 'create-alpha',
                    up: async (transaction: { execute(sql: string): Promise<unknown> }) => {
                        await transaction.execute('CREATE TABLE entries (value BLOB NOT NULL)');
                    },
                })]),
                incumbentQueryFixture: Object.freeze({ id: 'alpha-v1', run: async () => undefined }),
            }),
            beta: Object.freeze({
                migrations: Object.freeze([Object.freeze({
                    version: 1,
                    id: 'create-beta',
                    up: async (transaction: { execute(sql: string): Promise<unknown> }) => {
                        await transaction.execute('CREATE TABLE entries (value BLOB NOT NULL)');
                    },
                })]),
                incumbentQueryFixture: Object.freeze({ id: 'beta-v1', run: async () => undefined }),
            }),
        });
        let closed = false;
        try {
            const alpha = await owner.storage.database('alpha', runtime.alpha);
            const beta = await owner.storage.database('beta', runtime.beta);

            let releaseAlphaCommit!: () => void;
            const alphaCommitGate = new Promise<void>((resolveGate) => {
                releaseAlphaCommit = resolveGate;
            });
            let markAlphaWritten!: () => void;
            const alphaWritten = new Promise<void>((resolveWritten) => {
                markAlphaWritten = resolveWritten;
            });
            const alphaWrite = alpha.transaction(async (transaction) => {
                await transaction.execute('INSERT INTO entries (value) VALUES (zeroblob(?))', [32 * 1024]);
                markAlphaWritten();
                await alphaCommitGate;
            });
            await alphaWritten;

            await expect(beta.execute('INSERT INTO entries (value) VALUES (zeroblob(?))', [32 * 1024]))
                .rejects.toMatchObject({ code: 'daemon_database_quota_exceeded' });
            releaseAlphaCommit();
            await expect(alphaWrite).resolves.toBeUndefined();

            await expect(alpha.query('SELECT COUNT(*) AS count FROM entries')).resolves.toEqual([{ count: 1 }]);
            await expect(beta.query('SELECT COUNT(*) AS count FROM entries')).resolves.toEqual([{ count: 0 }]);

            await owner.close();
            closed = true;
            let aggregatePageBytes = 0;
            for (const localId of ['alpha', 'beta']) {
                const database = openSqliteDatabaseSync(join(
                    paths.storageDir,
                    'acme.indexer',
                    'databases',
                    `${localId}.sqlite`,
                ));
                try {
                    const pageSize = database.prepare('PRAGMA page_size').get() as { page_size: number };
                    const pageCount = database.prepare('PRAGMA page_count').get() as { page_count: number };
                    aggregatePageBytes += pageSize.page_size * pageCount.page_count;
                } finally {
                    database.close();
                }
            }
            expect(aggregatePageBytes).toBeLessThanOrEqual(limits.maximumDatabaseBytes);
        } finally {
            if (!closed) await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    // This lifecycle test deliberately creates, quiesces, and replaces several
    // real isolated SQLite workers through the source-run worker entry.
    it('quiesces an incumbent, rejects an invalid candidate fixture, then admits its read-only CTE fixture', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const controller = new AbortController();
        const limits = {
            maximumDatabaseBytes: 1_048_576,
            maximumInputBytes: 16_384,
            maximumResultBytes: 16_384,
            maximumResultRows: 100,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        } as const;
        const policy = Object.freeze({
            protocolMaximumDatabaseBytes: limits.maximumDatabaseBytes,
            resolvePluginLimits: (pluginId: string) => (
                pluginId === 'acme.indexer' ? limits : null
            ),
        });
        let rejectIncumbentFixture = false;
        const incumbentRuntime = Object.freeze({
            index: Object.freeze({
                migrations: Object.freeze([Object.freeze({
                    version: 1,
                    id: 'create-records',
                    up: async (transaction: { execute(sql: string): Promise<unknown> }) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                })]),
                incumbentQueryFixture: Object.freeze({
                    id: 'records-v1',
                    run: async (transaction: { query(sql: string): Promise<unknown> }) => {
                        await transaction.query(`
                            WITH retained_records AS (
                                SELECT value FROM records
                            )
                            SELECT value FROM retained_records ORDER BY value
                        `);
                        if (rejectIncumbentFixture) throw new Error('incumbent query contract rejected candidate');
                    },
                }),
            }),
        });
        const candidateRuntime = Object.freeze({
            index: Object.freeze({
                migrations: Object.freeze([
                    incumbentRuntime.index.migrations[0]!,
                    Object.freeze({
                        version: 2,
                        id: 'add-label',
                        up: async (transaction: { execute(sql: string): Promise<unknown> }) => {
                            await transaction.execute('ALTER TABLE records ADD COLUMN label TEXT');
                        },
                    }),
                ]),
                incumbentQueryFixture: Object.freeze({
                    id: 'records-v2',
                    run: async (transaction: { query(sql: string): Promise<unknown> }) => {
                        await transaction.query('SELECT value, label FROM records ORDER BY value');
                    },
                }),
            }),
        });
        const declarations = Object.freeze([{
            id: 'index',
            migrations: [{ version: 1, id: 'create-records' }],
            incumbentQueryFixtureId: 'records-v1',
        }]);
        const incumbent = createStablePluginDaemonDatabaseHost({ paths, daemonDatabaseLimits: policy });
        const candidate = createStablePluginDaemonDatabaseHost({ paths, daemonDatabaseLimits: policy });
        try {
            await incumbent.prepare({
                pluginId: 'acme.indexer',
                generation: '1',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                declarations,
                runtime: incumbentRuntime,
            });
            const incumbentStorage = createStablePluginStorageService({
                pluginId: 'acme.indexer',
                paths,
                generation: '1',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                daemonDatabase: incumbent,
            });
            const incumbentDatabase = await incumbentStorage.daemon.database('index', incumbentRuntime.index);
            await incumbentDatabase.execute('INSERT INTO records (value) VALUES (?)', ['retained']);

            const quiescence = await incumbent.quiesce(['acme.indexer']);
            await expect(incumbentDatabase.query('SELECT value FROM records')).rejects.toMatchObject({
                code: 'daemon_database_quiesced',
            });
            rejectIncumbentFixture = true;
            await expect(candidate.prepare({
                pluginId: 'acme.indexer',
                generation: '2',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                declarations: [{
                    id: 'index',
                    migrations: [
                        { version: 1, id: 'create-records' },
                        { version: 2, id: 'add-label' },
                    ],
                    incumbentQueryFixtureId: 'records-v2',
                }],
                runtime: candidateRuntime,
                incumbentContracts: incumbent.readPreparedContracts('acme.indexer'),
            })).rejects.toMatchObject({ code: 'daemon_database_migration_requires_future_contract' });
            await quiescence.resume();

            const resumedDatabase = await incumbentStorage.daemon.database('index', incumbentRuntime.index);
            await expect(resumedDatabase.query('SELECT value FROM records ORDER BY value')).resolves.toEqual([
                { value: 'retained' },
            ]);
            await expect(resumedDatabase.query('SELECT label FROM records')).rejects.toBeDefined();

            rejectIncumbentFixture = false;
            await incumbent.quiesce(['acme.indexer']);
            await expect(candidate.prepare({
                pluginId: 'acme.indexer',
                generation: '2',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                declarations: [{
                    id: 'index',
                    migrations: [
                        { version: 1, id: 'create-records' },
                        { version: 2, id: 'add-label' },
                    ],
                    incumbentQueryFixtureId: 'records-v2',
                }],
                runtime: candidateRuntime,
                incumbentContracts: incumbent.readPreparedContracts('acme.indexer'),
            })).resolves.toBeUndefined();
            const candidateStorage = createStablePluginStorageService({
                pluginId: 'acme.indexer',
                paths,
                generation: '2',
                signal: controller.signal,
                isGenerationCurrent: () => true,
                daemonDatabase: candidate,
            });
            const candidateDatabase = await candidateStorage.daemon.database('index', candidateRuntime.index);
            await expect(candidateDatabase.query('SELECT value, label FROM records ORDER BY value')).resolves.toEqual([
                { value: 'retained', label: null },
            ]);
        } finally {
            await candidate.close();
            await incumbent.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    }, 60_000);

    it('opens a host-derived database only after the exact declared runtime contract is supplied', async () => {
        const happyHomeDir = await makeHappyHome();
        const controller = new AbortController();
        let current = true;
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: controller.signal,
            isGenerationCurrent: () => current,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 5_000,
            },
            declarations: [{
                id: 'main',
                migrations: [{ version: 1, id: 'create-records' }],
                incumbentQueryFixtureId: 'records-v1',
            }],
        });
        try {
            const database = await owner.storage.database('main', {
                migrations: [{
                    version: 1,
                    id: 'create-records',
                    up: async (transaction) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                }],
                incumbentQueryFixture: {
                    id: 'records-v1',
                    run: async (transaction) => {
                        await transaction.query('SELECT value FROM records ORDER BY value');
                    },
                },
            });

            await database.execute('INSERT INTO records (value) VALUES (?)', ['persisted']);

            await expect(database.query('SELECT value FROM records')).resolves.toEqual([
                { value: 'persisted' },
            ]);
            await expect(database.query('SELECT * FROM _happier_plugin_schema')).rejects.toMatchObject({
                code: 'daemon_database_reserved_schema',
            });
            await expect(database.execute("INSERT INTO records (value) VALUES ('ignored'); DELETE FROM records"))
                .rejects.toMatchObject({ code: 'daemon_database_statement_tail' });
            await expect(database.execute('CREATE TABLE "temp".escaped_records (value TEXT NOT NULL)'))
                .rejects.toMatchObject({ code: 'daemon_database_statement_forbidden' });

            current = false;
            await expect(database.query('SELECT value FROM records')).rejects.toMatchObject({
                code: 'plugin_generation_stale',
            });
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('rejects a later open that tries to reinterpret an already prepared static declaration', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 5_000,
            },
            declarations: [{
                id: 'main',
                migrations: [{ version: 1, id: 'create-records' }],
                incumbentQueryFixtureId: 'records-v1',
            }],
        });
        try {
            await owner.storage.database('main', {
                migrations: [{
                    version: 1,
                    id: 'create-records',
                    up: async (transaction) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                }],
                incumbentQueryFixture: {
                    id: 'records-v1',
                    run: async (transaction) => {
                        await transaction.query('SELECT value FROM records');
                    },
                },
            });

            await expect(owner.storage.database('main', {
                migrations: [{
                    version: 1,
                    id: 'reinterpret-records',
                    up: async () => undefined,
                }],
                incumbentQueryFixture: {
                    id: 'records-v1',
                    run: async (transaction) => {
                        await transaction.query('SELECT value FROM records');
                    },
                },
            })).rejects.toMatchObject({
                code: 'daemon_database_declaration_mismatch',
            });
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('opens an exactly declared database with no migrations when the author omits the empty array', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 5_000,
            },
            declarations: [{
                id: 'scratch',
                migrations: [],
                incumbentQueryFixtureId: 'scratch-v1',
            }],
        });
        try {
            const database = await owner.storage.database('scratch', {
                incumbentQueryFixture: {
                    id: 'scratch-v1',
                    run: async (transaction) => {
                        await transaction.query('SELECT 1');
                    },
                },
            });

            await database.execute('CREATE TABLE records (value TEXT NOT NULL)');
            await expect(database.query('SELECT value FROM records')).resolves.toEqual([]);
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('releases a cancelled queued operation so retirement can close the database', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 5_000,
            },
            declarations: [{
                id: 'main',
                migrations: [{ version: 1, id: 'create-records' }],
                incumbentQueryFixtureId: 'records-v1',
            }],
        });
        try {
            const database = await owner.storage.database('main', {
                migrations: [{
                    version: 1,
                    id: 'create-records',
                    up: async (transaction) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                }],
                incumbentQueryFixture: {
                    id: 'records-v1',
                    run: async (transaction) => {
                        await transaction.query('SELECT value FROM records');
                    },
                },
            });
            let releaseFirstOperation!: () => void;
            const firstOperationGate = new Promise<void>((resolveGate) => {
                releaseFirstOperation = resolveGate;
            });
            const firstOperation = database.transaction(async (transaction) => {
                await firstOperationGate;
                return await transaction.query('SELECT value FROM records');
            });
            const queuedOperationController = new AbortController();
            const queuedOperation = database.query(
                'SELECT value FROM records',
                [],
                { signal: queuedOperationController.signal },
            );

            queuedOperationController.abort();
            releaseFirstOperation();

            await expect(firstOperation).resolves.toEqual([]);
            await expect(queuedOperation).rejects.toMatchObject({
                code: 'daemon_database_cancelled',
                retryable: true,
            });
            await expect(Promise.race([
                owner.close().then(() => 'closed'),
                new Promise<'timed_out'>((resolveTimeout) => {
                    setTimeout(() => resolveTimeout('timed_out'), 250);
                }),
            ])).resolves.toBe('closed');
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('interrupts an in-flight long query when its signal aborts without blocking the daemon event loop', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 5_000,
            },
            declarations: [{
                id: 'main',
                migrations: [],
                incumbentQueryFixtureId: 'main-v1',
            }],
        });
        try {
            const database = await owner.storage.database('main', {
                incumbentQueryFixture: {
                    id: 'main-v1',
                    run: async () => undefined,
                },
            });
            const controller = new AbortController();
            let releaseAbortTimer!: () => void;
            const abortTimer = new Promise<void>((resolveTimer) => {
                releaseAbortTimer = resolveTimer;
            });
            setTimeout(() => {
                controller.abort();
                releaseAbortTimer();
            }, 0);

            // This uses the real SQLite adapter below its one mocked-module
            // boundary. A boundary mock cannot establish whether a synchronous
            // driver leaves the daemon event loop able to deliver cancellation.
            const operation = database.query(
                `WITH RECURSIVE counter(value) AS (
                    VALUES(0)
                    UNION ALL
                    SELECT value + 1 FROM counter WHERE value < ?
                )
                SELECT sum(value) AS total FROM counter`,
                [50_000],
                { signal: controller.signal },
            );
            const firstSettlement = await Promise.race([
                abortTimer.then(() => 'aborted' as const),
                operation.then(
                    () => 'operation-settled' as const,
                    () => 'operation-settled' as const,
                ),
            ]);
            await abortTimer;

            expect(firstSettlement).toBe('aborted');
            await expect(operation).rejects.toMatchObject({
                code: 'daemon_database_cancelled',
            });
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('rolls back an interrupted transaction before reopening that database entry', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                // The recovery assertion starts a fresh source-run worker after
                // cancellation; keep that harness startup outside this test's
                // cancellation contract rather than racing the provisional
                // production default.
                maximumElapsedMs: 60_000,
            },
            declarations: [{
                id: 'main',
                migrations: [],
                incumbentQueryFixtureId: 'main-v1',
            }],
        });
        try {
            const database = await owner.storage.database('main', {
                incumbentQueryFixture: {
                    id: 'main-v1',
                    run: async () => undefined,
                },
            });
            await database.execute('CREATE TABLE records (value TEXT NOT NULL)');

            const controller = new AbortController();
            let releaseAbortTimer!: () => void;
            const abortTimer = new Promise<void>((resolveTimer) => {
                releaseAbortTimer = resolveTimer;
            });
            const operation = database.transaction(async (transaction) => {
                await transaction.execute('INSERT INTO records (value) VALUES (?)', ['interrupted']);
                setTimeout(() => {
                    controller.abort();
                    releaseAbortTimer();
                }, 0);
                return await transaction.query(
                    `WITH RECURSIVE counter(value) AS (
                        VALUES(0)
                        UNION ALL
                        SELECT value + 1 FROM counter WHERE value < ?
                    )
                    SELECT sum(value) AS total FROM counter`,
                    [50_000],
                    { signal: controller.signal },
                );
            }, { signal: controller.signal });

            const firstSettlement = await Promise.race([
                abortTimer.then(() => 'aborted' as const),
                operation.then(
                    () => 'operation-settled' as const,
                    () => 'operation-settled' as const,
                ),
            ]);
            await abortTimer;

            expect(firstSettlement).toBe('aborted');
            await expect(operation).rejects.toMatchObject({
                code: 'daemon_database_cancelled',
            });
            await expect(database.query('SELECT value FROM records')).resolves.toEqual([]);
            await database.execute('INSERT INTO records (value) VALUES (?)', ['survived']);
            await expect(database.query('SELECT value FROM records')).resolves.toEqual([
                { value: 'survived' },
            ]);
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('reapplies connection-local SQLite policy after a cancelled worker is reopened', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 60_000,
            },
            declarations: [{
                id: 'main',
                migrations: [],
                incumbentQueryFixtureId: 'main-v1',
            }],
        });
        try {
            const database = await owner.storage.database('main', {
                incumbentQueryFixture: {
                    id: 'main-v1',
                    run: async () => undefined,
                },
            });
            const assertSynchronousNormal = async (): Promise<void> => {
                await expect(database.query('SELECT * FROM pragma_synchronous')).resolves.toEqual([
                    { synchronous: 1 },
                ]);
            };

            await assertSynchronousNormal();
            const controller = new AbortController();
            let releaseAbortTimer!: () => void;
            const abortTimer = new Promise<void>((resolveTimer) => {
                releaseAbortTimer = resolveTimer;
            });
            const operation = database.query(
                `WITH RECURSIVE counter(value) AS (
                    VALUES(0)
                    UNION ALL
                    SELECT value + 1 FROM counter WHERE value < ?
                )
                SELECT sum(value) AS total FROM counter`,
                [50_000],
                { signal: controller.signal },
            );
            setTimeout(() => {
                controller.abort();
                releaseAbortTimer();
            }, 0);

            await abortTimer;
            await expect(operation).rejects.toMatchObject({
                code: 'daemon_database_cancelled',
            });
            await assertSynchronousNormal();
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('enforces maximumElapsedMs without waiting for an in-flight SQLite query to return', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 100,
            },
            declarations: [{
                id: 'main',
                migrations: [],
                incumbentQueryFixtureId: 'main-v1',
            }],
        });
        try {
            const database = await owner.storage.database('main', {
                incumbentQueryFixture: {
                    id: 'main-v1',
                    run: async () => undefined,
                },
            });
            let releaseTimer!: () => void;
            const eventLoopTimer = new Promise<void>((resolveTimer) => {
                releaseTimer = resolveTimer;
            });
            setTimeout(releaseTimer, 0);
            const operation = database.query(
                `WITH RECURSIVE counter(value) AS (
                    VALUES(0)
                    UNION ALL
                    SELECT value + 1 FROM counter WHERE value < ?
                )
                SELECT sum(value) AS total FROM counter`,
                [2_000_000],
            );
            const firstSettlement = await Promise.race([
                eventLoopTimer.then(() => 'timer' as const),
                operation.then(
                    () => 'operation-settled' as const,
                    () => 'operation-settled' as const,
                ),
            ]);
            await eventLoopTimer;

            expect(firstSettlement).toBe('timer');
            await expect(operation).rejects.toMatchObject({
                code: 'daemon_database_timeout',
                retryable: true,
            });
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('serializes concurrent opens of one database through one initialized owner entry', async () => {
        const happyHomeDir = await makeHappyHome();
        const owner = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits: {
                maximumDatabaseBytes: 1_048_576,
                maximumInputBytes: 16_384,
                maximumResultBytes: 16_384,
                maximumResultRows: 100,
                maximumAffectedRows: 1_000,
                maximumElapsedMs: 5_000,
            },
            declarations: [{
                id: 'main',
                migrations: [{ version: 1, id: 'create-records' }],
                incumbentQueryFixtureId: 'records-v1',
            }],
        });
        let migrationRuns = 0;
        const open = async () => await owner.storage.database('main', {
            migrations: [{
                version: 1,
                id: 'create-records',
                up: async (transaction) => {
                    migrationRuns += 1;
                    await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                },
            }],
            incumbentQueryFixture: {
                id: 'records-v1',
                run: async (transaction) => {
                    await transaction.query('SELECT value FROM records');
                },
            },
        });
        try {
            const databases = await Promise.all([
                open(),
                open(),
                open(),
                open(),
            ]);

            expect(migrationRuns).toBe(1);
            let releaseFirstTransaction!: () => void;
            const firstTransactionGate = new Promise<void>((resolveGate) => {
                releaseFirstTransaction = resolveGate;
            });
            let markFirstTransactionEntered!: () => void;
            const firstTransactionEntered = new Promise<void>((resolveEntered) => {
                markFirstTransactionEntered = resolveEntered;
            });
            const firstTransaction = databases[0]!.transaction(async (transaction) => {
                markFirstTransactionEntered();
                await firstTransactionGate;
                await transaction.execute('INSERT INTO records (value) VALUES (?)', ['first']);
            });
            await firstTransactionEntered;

            let secondTransactionEntered = false;
            const secondTransaction = databases[3]!.transaction(async (transaction) => {
                secondTransactionEntered = true;
                await transaction.execute('INSERT INTO records (value) VALUES (?)', ['second']);
            });
            await Promise.resolve();
            expect(secondTransactionEntered).toBe(false);

            releaseFirstTransaction();
            await expect(firstTransaction).resolves.toBeUndefined();
            await expect(secondTransaction).resolves.toBeUndefined();
            await expect(databases[3]!.query('SELECT value FROM records ORDER BY value')).resolves.toEqual([
                { value: 'first' },
                { value: 'second' },
            ]);
        } finally {
            await owner.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('refuses a retained migration when the carried prior fixture identity was altered', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const limits = {
            maximumDatabaseBytes: 1_048_576,
            maximumInputBytes: 16_384,
            maximumResultBytes: 16_384,
            maximumResultRows: 100,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        } as const;
        const first = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            limits,
            declarations: [{
                id: 'main',
                migrations: [{ version: 1, id: 'create-records' }],
                incumbentQueryFixtureId: 'records-v1',
            }],
        });
        try {
            await first.storage.database('main', {
                migrations: [{
                    version: 1,
                    id: 'create-records',
                    up: async (transaction) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                }],
                incumbentQueryFixture: {
                    id: 'records-v1',
                    run: async (transaction) => {
                        await transaction.query('SELECT value FROM records');
                    },
                },
            });
            const incumbentContracts = new Map(
                first.readPreparedContracts().map((contract) => [
                    contract.id,
                    {
                        ...contract,
                        incumbentQueryFixture: {
                            ...contract.incumbentQueryFixture,
                            id: 'altered-records-v1',
                        },
                    },
                ]),
            );
            await first.close();

            const candidate = createPluginDaemonDatabaseOwner({
                pluginId: 'acme.indexer',
                paths,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
                limits,
                incumbentContracts,
                declarations: [{
                    id: 'main',
                    migrations: [
                        { version: 1, id: 'create-records' },
                        { version: 2, id: 'add-label' },
                    ],
                    incumbentQueryFixtureId: 'records-v2',
                }],
            });
            try {
                await expect(candidate.storage.database('main', {
                    migrations: [
                        { version: 1, id: 'create-records', up: async () => undefined },
                        {
                            version: 2,
                            id: 'add-label',
                            up: async (transaction) => {
                                await transaction.execute('ALTER TABLE records ADD COLUMN label TEXT');
                            },
                        },
                    ],
                    incumbentQueryFixture: {
                        id: 'records-v2',
                        run: async (transaction) => {
                            await transaction.query('SELECT value FROM records');
                        },
                    },
                })).rejects.toMatchObject({
                    code: 'daemon_database_migration_requires_future_contract',
                });
            } finally {
                await candidate.close();
            }

            const raw = openSqliteDatabaseSync(join(paths.storageDir, 'acme.indexer', 'databases', 'main.sqlite'));
            try {
                expect(raw.prepare('PRAGMA table_info(records)').all()).not.toEqual(
                    expect.arrayContaining([expect.objectContaining({ name: 'label' })]),
                );
                expect(raw.prepare(`SELECT version, id FROM _happier_plugin_schema ORDER BY version`).all()).toEqual([
                    { version: 1, id: 'create-records' },
                ]);
            } finally {
                raw.close();
            }
        } finally {
            await first.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('rolls back a candidate migration and reports a future-contract refusal when its exact incumbent fixture is invalid', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const controller = new AbortController();
        const limits = {
            maximumDatabaseBytes: 1_048_576,
            maximumInputBytes: 16_384,
            maximumResultBytes: 16_384,
            maximumResultRows: 100,
            maximumAffectedRows: 1_000,
            maximumElapsedMs: 5_000,
        } as const;
        const first = createPluginDaemonDatabaseOwner({
            pluginId: 'acme.indexer',
            paths,
            signal: controller.signal,
            isGenerationCurrent: () => true,
            limits,
            declarations: [{
                id: 'main',
                migrations: [{ version: 1, id: 'create-records' }],
                incumbentQueryFixtureId: 'records-v1',
            }],
        });
        const databaseFilePath = join(paths.storageDir, 'acme.indexer', 'databases', 'main.sqlite');
        try {
            const initial = await first.storage.database('main', {
                migrations: [{
                    version: 1,
                    id: 'create-records',
                    up: async (transaction) => {
                        await transaction.execute('CREATE TABLE records (value TEXT NOT NULL)');
                    },
                }],
                // A candidate cannot make a CTE-backed mutation look like an
                // incumbent query fixture.
                incumbentQueryFixture: {
                    id: 'records-v1',
                    run: async (transaction) => {
                        await transaction.query(`
                            WITH retained_records AS (
                                SELECT value FROM records
                            )
                            DELETE FROM records
                            WHERE value IN (SELECT value FROM retained_records)
                        `);
                    },
                },
            });
            await initial.execute('INSERT INTO records (value) VALUES (?)', ['retained']);
            const incumbentContracts = new Map(
                first.readPreparedContracts().map((contract) => [
                    contract.id,
                    contract,
                ]),
            );
            await first.close();

            const candidate = createPluginDaemonDatabaseOwner({
                pluginId: 'acme.indexer',
                paths,
                signal: controller.signal,
                isGenerationCurrent: () => true,
                limits,
                incumbentContracts,
                declarations: [{
                    id: 'main',
                    migrations: [
                        { version: 1, id: 'create-records' },
                        { version: 2, id: 'add-label' },
                    ],
                    incumbentQueryFixtureId: 'records-v2',
                }],
            });
            try {
                await expect(candidate.storage.database('main', {
                    migrations: [
                        {
                            version: 1,
                            id: 'create-records',
                            up: async () => undefined,
                        },
                        {
                            version: 2,
                            id: 'add-label',
                            up: async (transaction) => {
                                await transaction.execute('ALTER TABLE records ADD COLUMN label TEXT');
                            },
                        },
                    ],
                    incumbentQueryFixture: {
                        id: 'records-v2',
                        run: async (transaction) => {
                            await transaction.query('SELECT value FROM records');
                        },
                    },
                })).rejects.toMatchObject({
                    code: 'daemon_database_migration_requires_future_contract',
                    message: expect.stringContaining('read-only'),
                });
            } finally {
                await candidate.close();
            }

            const raw = openSqliteDatabaseSync(databaseFilePath);
            try {
                expect(raw.prepare('SELECT value FROM records').all()).toEqual([{ value: 'retained' }]);
                expect(raw.prepare(`SELECT version, id FROM _happier_plugin_schema ORDER BY version`).all()).toEqual([
                    { version: 1, id: 'create-records' },
                ]);
                expect(raw.prepare('PRAGMA table_info(records)').all()).not.toEqual(
                    expect.arrayContaining([expect.objectContaining({ name: 'label' })]),
                );
            } finally {
                raw.close();
            }
        } finally {
            await first.close();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

});
