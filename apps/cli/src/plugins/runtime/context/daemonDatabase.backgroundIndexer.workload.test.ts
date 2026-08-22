import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from '@/daemon/persistence/sqliteSync';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { createPluginDaemonDatabaseOwner } from './daemonDatabase';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from './daemonDatabaseLimitsPolicy';

const BACKGROUND_INDEXER_LIMITS = DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY
    .resolvePluginLimits('examples.background-indexer');

if (!BACKGROUND_INDEXER_LIMITS) {
    throw new Error('background_indexer_daemon_database_limits_unavailable');
}

function workspacePath(index: number): string {
    return `workspaces/repository-${String(index % 100).padStart(3, '0')}/src/file-${String(index).padStart(6, '0')}.ts`;
}

function contentDigest(index: number): string {
    return index.toString(16).padStart(64, '0');
}

async function yieldToDaemonEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function roundMillis(value: number): number {
    return Math.round(value * 100) / 100;
}

function summarizeElapsedMs(samples: readonly number[]): Readonly<{
    count: number;
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}> {
    if (samples.length === 0) throw new Error('background_indexer_workload_missing_timing_samples');
    const ordered = [...samples].sort((left, right) => left - right);
    const at = (percentile: number): number => ordered[Math.min(
        ordered.length - 1,
        Math.max(0, Math.ceil(ordered.length * percentile) - 1),
    )]!;
    return Object.freeze({
        count: ordered.length,
        min: roundMillis(ordered[0]!),
        p50: roundMillis(at(0.50)),
        p95: roundMillis(at(0.95)),
        p99: roundMillis(at(0.99)),
        max: roundMillis(ordered.at(-1)!),
    });
}

describe.runIf(process.env.HAPPIER_RUN_DAEMON_DATABASE_WORKLOAD === '1')(
    'Background Indexer daemon-database workload',
    () => {
        for (const rowCount of [50_000, 500_000] as const) {
            it(`measures ${rowCount.toLocaleString('en-US')} indexed workspace records`, async () => {
                const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-background-indexer-workload-'));
                const paths = resolvePluginStorePaths({ happyHomeDir });
                const controller = new AbortController();
                const owner = createPluginDaemonDatabaseOwner({
                    pluginId: 'examples.background-indexer',
                    paths,
                    signal: controller.signal,
                    isGenerationCurrent: () => true,
                    limits: BACKGROUND_INDEXER_LIMITS,
                    declarations: [{
                        id: 'workspace-index',
                        migrations: [{ version: 1, id: 'create-workspace-index' }],
                        incumbentQueryFixtureId: 'workspace-index-v1',
                    }],
                });
                const databasePath = join(
                    paths.storageDir,
                    'examples.background-indexer',
                    'databases',
                    'workspace-index.sqlite',
                );
                let interval: NodeJS.Timeout | undefined;
                let closed = false;
                let maximumEventLoopDelayMs = 0;
                let eventLoopTickCount = 0;
                let expectedTickAt = 0;

                try {
                    const database = await owner.storage.database('workspace-index', {
                        migrations: [{
                            version: 1,
                            id: 'create-workspace-index',
                            up: async (transaction) => {
                                await transaction.execute(
                                    'CREATE TABLE workspace_documents (path TEXT PRIMARY KEY, content_digest TEXT NOT NULL, indexed_at_ms INTEGER NOT NULL)',
                                );
                                await transaction.execute(
                                    'CREATE INDEX workspace_documents_by_indexed_at ON workspace_documents (indexed_at_ms)',
                                );
                            },
                        }],
                        incumbentQueryFixture: {
                            id: 'workspace-index-v1',
                            run: async (transaction) => {
                                await transaction.query(
                                    'SELECT path, content_digest FROM workspace_documents ORDER BY path LIMIT 1',
                                );
                            },
                        },
                    });
                    expectedTickAt = performance.now() + 20;
                    interval = setInterval(() => {
                        const now = performance.now();
                        maximumEventLoopDelayMs = Math.max(maximumEventLoopDelayMs, now - expectedTickAt);
                        expectedTickAt = now + 20;
                        eventLoopTickCount += 1;
                    }, 20);

                    const startedAt = performance.now();
                    const batchSize = 100;
                    const writeTransactionElapsedMs: number[] = [];
                    for (let start = 0; start < rowCount; start += batchSize) {
                        const end = Math.min(rowCount, start + batchSize);
                        const batchStartedAt = performance.now();
                        await database.transaction(async (transaction) => {
                            for (let index = start; index < end; index += 1) {
                                await transaction.execute(
                                    'INSERT INTO workspace_documents (path, content_digest, indexed_at_ms) VALUES (?, ?, ?)',
                                    [workspacePath(index), contentDigest(index), index],
                                );
                            }
                        });
                        writeTransactionElapsedMs.push(performance.now() - batchStartedAt);
                        // This is one bounded ingestion pass, not a scheduler: it
                        // makes the public async contract cooperative between
                        // ordinary write batches while retaining one database owner.
                        await yieldToDaemonEventLoop();
                    }
                    const writeElapsedMs = performance.now() - startedAt;
                    const criticalReadStartedAt = performance.now();
                    const criticalRows = await database.query(
                        'SELECT path, content_digest FROM workspace_documents WHERE indexed_at_ms >= ? ORDER BY indexed_at_ms LIMIT 25',
                        [rowCount - 25],
                    );
                    const criticalReadElapsedMs = performance.now() - criticalReadStartedAt;
                    const pointReadStartedAt = performance.now();
                    const pointRows = await database.query(
                        'SELECT path, content_digest FROM workspace_documents WHERE path = ?',
                        [workspacePath(Math.floor(rowCount / 2))],
                    );
                    const pointReadElapsedMs = performance.now() - pointReadStartedAt;
                    expect(criticalRows).toHaveLength(25);
                    expect(pointRows).toHaveLength(1);

                    if (interval) clearInterval(interval);
                    interval = undefined;
                    await owner.close();
                    closed = true;

                    const rawDatabase = openSqliteDatabaseSync(databasePath);
                    let pageBytes = 0;
                    try {
                        const pageSize = rawDatabase.prepare('PRAGMA page_size').get() as { page_size: number };
                        const pageCount = rawDatabase.prepare('PRAGMA page_count').get() as { page_count: number };
                        pageBytes = pageSize.page_size * pageCount.page_count;
                    } finally {
                        rawDatabase.close();
                    }
                    const mainFileBytes = (await stat(databasePath)).size;
                    const walFileBytes = await stat(`${databasePath}-wal`)
                        .then((metadata) => metadata.size)
                        .catch(() => 0);

                    expect(pageBytes).toBeLessThanOrEqual(BACKGROUND_INDEXER_LIMITS.maximumDatabaseBytes);
                    process.stdout.write(`BACKGROUND_INDEXER_DAEMON_DATABASE_WORKLOAD_V1 ${JSON.stringify({
                        environment: {
                            runtime: process.versions.bun ? `bun-${process.versions.bun}` : process.version,
                            platform: process.platform,
                            arch: process.arch,
                        },
                        corpus: { rowCount, batchSize },
                        limits: BACKGROUND_INDEXER_LIMITS,
                        timingsMs: {
                            write: roundMillis(writeElapsedMs),
                            criticalRead: roundMillis(criticalReadElapsedMs),
                            pointRead: roundMillis(pointReadElapsedMs),
                            maximumEventLoopDelay: roundMillis(maximumEventLoopDelayMs),
                            eventLoopTicks: eventLoopTickCount,
                            writeTransactionDistribution: summarizeElapsedMs(writeTransactionElapsedMs),
                        },
                        storageBytes: { pageBytes, mainFileBytes, walFileBytes },
                    })}\n`);
                } finally {
                    if (interval) clearInterval(interval);
                    if (!closed) await owner.close();
                    await rm(happyHomeDir, { recursive: true, force: true });
                }
            }, 180_000);
        }
    },
);
