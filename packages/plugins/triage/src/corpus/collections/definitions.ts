import type { PluginAccountCollectionMigrationRuntimeProjection } from '@happier-dev/plugin-sdk';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TriageConfiguredSourceInstanceV1JsonSchema,
    TriageEntryRefV1JsonSchema,
} from '@happier-dev/triage-protocol/v1';

import {
    CORPUS_IDENTITY_TAG_LENGTH,
    CORPUS_IDENTITY_TAG_PATTERN,
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_FIELD,
    CORPUS_SESSION_LINKS_INDEX_ID,
    CORPUS_SESSION_LINKS_UI_QUERY_ID,
    CORPUS_SESSION_LINKS_UI_QUERY_PAGE_SIZE,
    CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    CORPUS_SOURCE_INSTANCES_FIELD,
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
    CORPUS_SOURCE_INSTANCE_RETIRED_REASONS,
    CORPUS_USER_MARKS_COLLECTION_ID,
    CORPUS_USER_MARKS_FIELD,
    CORPUS_USER_MARKS_INDEX_ID,
} from './ids.js';

/**
 * The declared Account Collections: exactly the three that hold durable user
 * state.
 *
 * Separation is by **writer**, not by topic. Each declared index is a
 * disclosure decision — an index value is plaintext server metadata even on an
 * E2EE Account — so every index below names the order it serves, and a "just in
 * case" index is a defect rather than a tuning choice. Between them a plaintext
 * and an E2EE Account disclose the same shapes: how many sources are
 * configured, how many entries have links, how many entries are pinned, and
 * which Sessions are involved.
 */

/** Every durable identity is a fixed-width tag over the row-id alphabet. */
const IDENTITY_TAG_SCHEMA: PluginJsonSchema = {
    type: 'string',
    minLength: CORPUS_IDENTITY_TAG_LENGTH,
    maxLength: CORPUS_IDENTITY_TAG_LENGTH,
    pattern: CORPUS_IDENTITY_TAG_PATTERN,
};

/** Our own clock, in milliseconds. Never a provider clock. */
const TIMESTAMP_MS_SCHEMA: PluginJsonSchema = { type: 'integer', minimum: 0 };

const boundedText = (maxLength: number): PluginJsonSchema => ({
    type: 'string',
    minLength: 1,
    maxLength,
});

const IDENTIFIER_SCHEMA = boundedText(MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1);
const TEXT_SCHEMA = boundedText(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);

export const CORPUS_SOURCE_INSTANCES_COLLECTION = defineAccountCollection({
    id: CORPUS_SOURCE_INSTANCES_COLLECTION_ID,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            [CORPUS_SOURCE_INSTANCES_FIELD.instanceTag]: IDENTITY_TAG_SCHEMA,
            [CORPUS_SOURCE_INSTANCES_FIELD.sourceQualifiedId]: IDENTIFIER_SCHEMA,
            [CORPUS_SOURCE_INSTANCES_FIELD.lifecycle]: {
                type: 'string',
                enum: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired],
            },
            [CORPUS_SOURCE_INSTANCES_FIELD.configuredAtMs]: TIMESTAMP_MS_SCHEMA,
            [CORPUS_SOURCE_INSTANCES_FIELD.configured]: TriageConfiguredSourceInstanceV1JsonSchema,
            [CORPUS_SOURCE_INSTANCES_FIELD.retiredReason]: {
                type: 'string',
                enum: [...CORPUS_SOURCE_INSTANCE_RETIRED_REASONS],
            },
        },
        required: [
            CORPUS_SOURCE_INSTANCES_FIELD.instanceTag,
            CORPUS_SOURCE_INSTANCES_FIELD.sourceQualifiedId,
            CORPUS_SOURCE_INSTANCES_FIELD.lifecycle,
            CORPUS_SOURCE_INSTANCES_FIELD.configuredAtMs,
            CORPUS_SOURCE_INSTANCES_FIELD.configured,
        ],
        additionalProperties: false,
    },
    rowIdField: CORPUS_SOURCE_INSTANCES_FIELD.instanceTag,
    identityFields: [CORPUS_SOURCE_INSTANCES_FIELD.instanceTag],
    /**
     * The exact account ref, the source-local matching key and the source's
     * routing configuration stay inside the private `configured` payload. Only
     * the installed contribution identity — which the contribution set already
     * discloses — and the lifecycle ordinal are projected.
     */
    serverReadable: [
        CORPUS_SOURCE_INSTANCES_FIELD.sourceQualifiedId,
        CORPUS_SOURCE_INSTANCES_FIELD.lifecycle,
        CORPUS_SOURCE_INSTANCES_FIELD.configuredAtMs,
    ],
    indexes: [{
        // Enumerating configured instances for Settings, view-driven refresh and
        // configured-tuple matching. It discloses how many instances exist and
        // how many are retired.
        id: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
        fields: [
            { field: CORPUS_SOURCE_INSTANCES_FIELD.lifecycle, direction: 'asc' },
            { field: CORPUS_SOURCE_INSTANCES_FIELD.configuredAtMs, direction: 'asc' },
        ],
    }],
    uiQueries: [],
    relations: [],
    // No readable schema version below the current one, so there is no
    // ordered migration edge to declare and none to implement in the
    // executable half.
    migrations: [],
});

export const CORPUS_SESSION_LINKS_COLLECTION = defineAccountCollection({
    id: CORPUS_SESSION_LINKS_COLLECTION_ID,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            [CORPUS_SESSION_LINKS_FIELD.linkTag]: IDENTITY_TAG_SCHEMA,
            [CORPUS_SESSION_LINKS_FIELD.entryTag]: IDENTITY_TAG_SCHEMA,
            [CORPUS_SESSION_LINKS_FIELD.sessionId]: IDENTIFIER_SCHEMA,
            [CORPUS_SESSION_LINKS_FIELD.linkedAtMs]: TIMESTAMP_MS_SCHEMA,
            [CORPUS_SESSION_LINKS_FIELD.cardPublicationId]: IDENTIFIER_SCHEMA,
            [CORPUS_SESSION_LINKS_FIELD.entryRef]: TriageEntryRefV1JsonSchema,
            [CORPUS_SESSION_LINKS_FIELD.identityEntryRef]: TriageEntryRefV1JsonSchema,
            [CORPUS_SESSION_LINKS_FIELD.displayPathAtLink]: TEXT_SCHEMA,
        },
        required: [
            CORPUS_SESSION_LINKS_FIELD.linkTag,
            CORPUS_SESSION_LINKS_FIELD.entryTag,
            CORPUS_SESSION_LINKS_FIELD.sessionId,
            CORPUS_SESSION_LINKS_FIELD.linkedAtMs,
            CORPUS_SESSION_LINKS_FIELD.cardPublicationId,
            CORPUS_SESSION_LINKS_FIELD.entryRef,
            CORPUS_SESSION_LINKS_FIELD.identityEntryRef,
            CORPUS_SESSION_LINKS_FIELD.displayPathAtLink,
        ],
        additionalProperties: false,
    },
    rowIdField: CORPUS_SESSION_LINKS_FIELD.linkTag,
    identityFields: [
        CORPUS_SESSION_LINKS_FIELD.linkTag,
        CORPUS_SESSION_LINKS_FIELD.entryTag,
    ],
    serverReadable: [
        CORPUS_SESSION_LINKS_FIELD.entryTag,
        CORPUS_SESSION_LINKS_FIELD.sessionId,
        CORPUS_SESSION_LINKS_FIELD.linkedAtMs,
    ],
    indexes: [
        {
            // The surface reading one entry's links, and the merge retarget.
            id: CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
            fields: [{ field: CORPUS_SESSION_LINKS_FIELD.entryTag, direction: 'asc' }],
        },
        {
            // A Session reading its linked entries; host ids are already plaintext.
            id: CORPUS_SESSION_LINKS_INDEX_ID.bySession,
            fields: [{ field: CORPUS_SESSION_LINKS_FIELD.sessionId, direction: 'asc' }],
        },
    ],
    uiQueries: [{
        // The Session cockpit's one read. It is prefixed on the mounted
        // `SessionId` so a mount can only ever see its own Session's links, and
        // it projects the link's own clock alone: the entry a link points at is
        // not stored anywhere, so the private row's frozen display path — read
        // by the same mount's Data client — is what a row renders from.
        id: CORPUS_SESSION_LINKS_UI_QUERY_ID.linkedForSession,
        indexId: CORPUS_SESSION_LINKS_INDEX_ID.bySession,
        parameters: {
            [CORPUS_SESSION_LINKS_FIELD.sessionId]: {
                kind: 'string',
                maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
            },
        },
        prefix: [{ kind: 'parameter', parameterId: CORPUS_SESSION_LINKS_FIELD.sessionId }],
        order: 'asc',
        pageSize: CORPUS_SESSION_LINKS_UI_QUERY_PAGE_SIZE,
        projectedFields: [CORPUS_SESSION_LINKS_FIELD.linkedAtMs],
    }],
    relations: [{
        id: 'session',
        kind: 'host',
        field: CORPUS_SESSION_LINKS_FIELD.sessionId,
        hostKind: 'session',
    }],
    // No readable schema version below the current one, so there is no
    // ordered migration edge to declare and none to implement in the
    // executable half.
    migrations: [],
});

export const CORPUS_USER_MARKS_COLLECTION = defineAccountCollection({
    id: CORPUS_USER_MARKS_COLLECTION_ID,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            [CORPUS_USER_MARKS_FIELD.markTag]: IDENTITY_TAG_SCHEMA,
            [CORPUS_USER_MARKS_FIELD.pinned]: { type: 'boolean' },
            [CORPUS_USER_MARKS_FIELD.markedAtMs]: TIMESTAMP_MS_SCHEMA,
            [CORPUS_USER_MARKS_FIELD.entryRef]: TriageEntryRefV1JsonSchema,
            [CORPUS_USER_MARKS_FIELD.displayAtMark]: {
                type: 'object',
                properties: { title: TEXT_SCHEMA, scopeLabel: TEXT_SCHEMA },
                required: ['title', 'scopeLabel'],
                additionalProperties: false,
            },
        },
        required: [
            CORPUS_USER_MARKS_FIELD.markTag,
            CORPUS_USER_MARKS_FIELD.pinned,
            CORPUS_USER_MARKS_FIELD.markedAtMs,
            CORPUS_USER_MARKS_FIELD.entryRef,
            CORPUS_USER_MARKS_FIELD.displayAtMark,
        ],
        additionalProperties: false,
    },
    rowIdField: CORPUS_USER_MARKS_FIELD.markTag,
    identityFields: [CORPUS_USER_MARKS_FIELD.markTag],
    serverReadable: [
        CORPUS_USER_MARKS_FIELD.pinned,
        CORPUS_USER_MARKS_FIELD.markedAtMs,
    ],
    indexes: [{
        // The pinned section: the marks query owns its cursor, order and count.
        id: CORPUS_USER_MARKS_INDEX_ID.byPinned,
        fields: [
            { field: CORPUS_USER_MARKS_FIELD.pinned, direction: 'asc' },
            { field: CORPUS_USER_MARKS_FIELD.markedAtMs, direction: 'desc' },
        ],
    }],
    uiQueries: [],
    relations: [],
    // No readable schema version below the current one, so there is no
    // ordered migration edge to declare and none to implement in the
    // executable half.
    migrations: [],
});

/** Every declared Account Collection, in one place, for manifest composition. */
export const CORPUS_ACCOUNT_COLLECTIONS = [
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
] as const;

/**
 * Executable half of `contributes.accountCollections`.
 *
 * The host rejects an author module whose projection does not name every
 * declared Collection, and whose per-Collection `migrate` callbacks are not the
 * ordered adjacent readable-schema-version edges the manifest declares. All
 * three Collections are at schema version 1 with no earlier readable version,
 * so all three carry zero edges today; deriving the projection from the same
 * declarations the manifest composes means a future schema-version bump adds
 * the callback beside its static identity instead of leaving the two halves to
 * drift.
 */
export const CORPUS_ACCOUNT_COLLECTION_MIGRATIONS:
PluginAccountCollectionMigrationRuntimeProjection = Object.freeze(Object.fromEntries(
    CORPUS_ACCOUNT_COLLECTIONS.map((collection) => [
        collection.id,
        Object.freeze([...collection.migrations ?? []]),
    ]),
));
