import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginDaemonDatabaseRuntimeProjection } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import type {
    DaemonDatabaseMigrationReadTransaction,
    DaemonDatabaseMigrationTransaction,
} from '@happier-dev/plugin-sdk/storage';

const WORKSPACE_INDEX_DATABASE = 'workspace-index';
const WORKSPACE_INDEX_HEARTBEAT_PATH = '.happier/background-indexer';
const WORKSPACE_INDEX_HEARTBEAT_DIGEST = 'background-indexer-v1';

export const daemonDatabases = Object.freeze({
    [WORKSPACE_INDEX_DATABASE]: Object.freeze({
        migrations: Object.freeze([Object.freeze({
            version: 1,
            id: 'create-workspace-index',
            up: async (transaction: DaemonDatabaseMigrationTransaction) => {
                await transaction.execute(
                    'CREATE TABLE workspace_documents (path TEXT PRIMARY KEY, content_digest TEXT NOT NULL, indexed_at_ms INTEGER NOT NULL)',
                );
                await transaction.execute(
                    'CREATE INDEX workspace_documents_by_indexed_at ON workspace_documents (indexed_at_ms)',
                );
            },
        })]),
        incumbentQueryFixture: Object.freeze({
            id: 'workspace-index-v1',
            run: async (transaction: DaemonDatabaseMigrationReadTransaction) => {
                await transaction.query(
                    'SELECT path, content_digest FROM workspace_documents ORDER BY path LIMIT 1',
                );
            },
        }),
    }),
}) satisfies PluginDaemonDatabaseRuntimeProjection;

/**
 * The host starts this one-shot generation-scoped runner after adoption. It
 * exercises the same declared database public API an indexer uses for ordinary
 * writes and query verification; it deliberately creates no poller or scheduler.
 */
export const runWorkspaceIndexer: BackgroundServiceRunner = async (context) => {
    context.signal.throwIfAborted();
    const database = await context.services.storage.daemon.database(
        WORKSPACE_INDEX_DATABASE,
        {
            migrations: daemonDatabases[WORKSPACE_INDEX_DATABASE].migrations,
            incumbentQueryFixture: daemonDatabases[WORKSPACE_INDEX_DATABASE].incumbentQueryFixture,
            signal: context.signal,
        },
    );
    context.signal.throwIfAborted();

    await database.transaction(async (transaction) => {
        await transaction.execute(
            'INSERT INTO workspace_documents (path, content_digest, indexed_at_ms) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET content_digest = excluded.content_digest, indexed_at_ms = excluded.indexed_at_ms',
            [WORKSPACE_INDEX_HEARTBEAT_PATH, WORKSPACE_INDEX_HEARTBEAT_DIGEST, Date.now()],
            { signal: context.signal },
        );
    }, { signal: context.signal });
    const indexed = await database.query(
        'SELECT path, content_digest FROM workspace_documents WHERE path = ?',
        [WORKSPACE_INDEX_HEARTBEAT_PATH],
        { signal: context.signal },
    );
    context.signal.throwIfAborted();
    if (indexed.length !== 1 || indexed[0]?.content_digest !== WORKSPACE_INDEX_HEARTBEAT_DIGEST) {
        throw new Error('background_indexer_heartbeat_not_indexed');
    }
};

export const { manifest, activate } = definePlugin({
    id: 'examples.background-indexer',
    version: '0.1.0',
    displayName: 'Background Indexer',
    description: 'A public-only daemon database and background-service reference.',
    entrypoints: { daemon: './dist/index.js' },
    hostAccess: { required: [], optional: [] },
    daemonDatabases,
    backgroundServices: [{
        declaration: {
            id: 'workspace-indexer',
            title: 'Index workspace documents',
        },
        runner: runWorkspaceIndexer,
    }],
});
