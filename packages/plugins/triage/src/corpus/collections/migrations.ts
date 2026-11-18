import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';
import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_USER_MARKS_COLLECTION_ID,
} from './ids.js';

export const CORPUS_COLLECTION_MIGRATIONS = {
    [CORPUS_SOURCE_INSTANCES_COLLECTION_ID]: [{
        id: 'source-instances-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        migrate: (value) => value,
    }, {
        id: 'source-instances-v2-to-v3',
        fromSchemaVersion: 2,
        toSchemaVersion: 3,
        // The Connected Account service union now admits happier/mcp-sign-in;
        // existing source bindings and private configuration stay unchanged.
        migrate: (value) => value,
    }, {
        id: 'source-instances-v3-to-v4',
        fromSchemaVersion: 3,
        toSchemaVersion: 4,
        // Account-data sources add an authority arm without changing existing bindings.
        migrate: (value) => value,
    }],
    [CORPUS_SESSION_LINKS_COLLECTION_ID]: [{
        id: 'session-links-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        migrate: (value) => value,
    }],
    [CORPUS_USER_MARKS_COLLECTION_ID]: [{
        id: 'user-marks-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
        migrate: (value) => value,
    }, {
        id: 'user-marks-v2-to-v3',
        fromSchemaVersion: 2,
        toSchemaVersion: 3,
        // Optional private Review relationship; retained user intent is unchanged.
        migrate: (value) => value,
    }],
} satisfies Readonly<Record<string, readonly PluginAccountCollectionMigration[]>>;
