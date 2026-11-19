import {
    PluginAccountCollectionContributionV1Schema,
    normalizePluginAccountCollectionContractV1,
} from '@happier-dev/protocol';
import {
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageReadFixPullRequestsResultV1Schema,
    TriageSetFixPullRequestInputV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/collections';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compilePluginJsonSchema, describePluginJsonSchemaValueIssues } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { fromCorpusStoredRow, toCorpusStoredValue } from './rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from './ids.js';
import { isPluginCollectionSchemaWideningV1, NormalizedPluginAccountCollectionContractV1Schema, resolvePluginCollectionContractAccessV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { decodePluginCollectionLogicalRowV1, encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { PLUGIN_COLLECTION_LIMITS_V1 } from '@happier-dev/protocol/plugins/data/collectionLimitsV1';
import { testkitAccountMaterial } from '../testkit/corpusCollections.test-support.js';
import { TriageListPinnedEntriesResultV1Schema, TriageSetEntryPinnedInputV1Schema } from '../../actions/userMarksProtocol.js';
import { TriageReadTaskOriginErrorResultV1Schema, TriageSetTaskOriginErrorInputV1Schema } from '../../actions/taskOriginProtocol.js';

import { PLUGIN_MANIFEST, collectionMigrations } from '../../manifest.js';
import {
    CORPUS_ACCOUNT_COLLECTIONS,
    CORPUS_SESSION_LINKS_COLLECTION,
    CORPUS_SOURCE_INSTANCES_COLLECTION,
    CORPUS_USER_MARKS_COLLECTION,
} from './definitions.js';

type JsonSchemaNode = Readonly<{
    properties?: Readonly<Record<string, JsonSchemaNode>>;
    items?: JsonSchemaNode;
    anyOf?: readonly JsonSchemaNode[];
    oneOf?: readonly JsonSchemaNode[];
    allOf?: readonly JsonSchemaNode[];
    additionalProperties?: boolean | JsonSchemaNode;
}>;

function collectSchemaMemberNames(node: JsonSchemaNode, into: Set<string>): Set<string> {
    for (const [name, child] of Object.entries(node.properties ?? {})) {
        into.add(name);
        collectSchemaMemberNames(child, into);
    }
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
        collectSchemaMemberNames(branch, into);
    }
    if (node.items) collectSchemaMemberNames(node.items, into);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        collectSchemaMemberNames(node.additionalProperties, into);
    }
    return into;
}

function admit(definition: (typeof CORPUS_ACCOUNT_COLLECTIONS)[number]) {
    const contribution = PluginAccountCollectionContributionV1Schema.parse(projectPluginAccountCollectionDeclaration(definition.id, definition));
    return normalizePluginAccountCollectionContractV1({
        pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        contribution,
    });
}

describe('durable Collection declarations', () => {
    it('reads the retained QA82 source-instances v4 writer without narrowing stored configuration', () => {
        // Public declaration captured from #82 on 2026-10-31, not Collection content.
        const retained = NormalizedPluginAccountCollectionContractV1Schema.parse(JSON.parse(readFileSync(
            new URL('../testkit/fixtures/sourceInstancesV4.qa82.json', import.meta.url), 'utf8')));
        const current = admit(CORPUS_SOURCE_INSTANCES_COLLECTION);
        expect(isPluginCollectionSchemaWideningV1({ source: retained, target: current })).toBe(true);
        expect(resolvePluginCollectionContractAccessV1({ currentWriter: retained, requested: current })).not.toBeNull();
        const narrowed = structuredClone(current);
        narrowed.schema.properties!.configured!.properties!.configuration!.properties!.token!['x-happier-max-utf8-bytes'] = 7_335;
        expect(isPluginCollectionSchemaWideningV1({ source: retained, target: narrowed })).toBe(false);
    });

    it('restores the incumbent user-marks v3 writer and can replace the narrower READY241 writer', () => {
        const declaration = PluginAccountCollectionContributionV1Schema.parse(
            projectPluginAccountCollectionDeclaration(CORPUS_USER_MARKS_COLLECTION.id, CORPUS_USER_MARKS_COLLECTION));
        const registered = (reviewId: { type: 'string'; minLength?: number }) => {
            const schema = structuredClone(declaration.schema);
            schema.properties!.admittedReview!.properties!.reviewId = reviewId;
            return normalizePluginAccountCollectionContractV1({
                pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
                contribution: { ...declaration, schema },
            });
        };
        const incumbent = registered({ type: 'string' });
        const narrowed = registered({ type: 'string', minLength: 1 });
        const current = admit(CORPUS_USER_MARKS_COLLECTION);
        // Writer refs observed on READY241 Accounts A and qa-triage-c3 pin the full contracts.
        expect(incumbent.contractDigest).toBe('BsbuqDfnIzgkehsd6tWxZvUBRurMEa8P9qpJ3cNdYLs');
        expect(narrowed.contractDigest).toBe('PrEatmT85MNRD75w_9z6w-BT0KA6jRubfRqYE0ZWrcY');
        expect(isPluginCollectionSchemaWideningV1({ source: incumbent, target: narrowed })).toBe(false);
        expect(isPluginCollectionSchemaWideningV1({ source: narrowed, target: incumbent })).toBe(true);

        const mark = (reviewId: string) => toCorpusStoredValue({
            markTag: `a${'1'.repeat(42)}`, pinned: true, markedAtMs: 1, entryRef: testkitEntryRef(),
            displayAtMark: { title: 'Pull request 17', scopeLabel: 'example/repository' },
            admittedReview: { reviewId, roundOrdinal: 1 },
        });
        const validateIncumbent = compilePluginJsonSchema(incumbent.schema);
        const validateNarrowed = compilePluginJsonSchema(narrowed.schema);
        expect(isValidPluginJsonSchemaValue(validateIncumbent, mark(''))).toBe(true);
        expect(isValidPluginJsonSchemaValue(validateNarrowed, mark(''))).toBe(false);
        expect(isValidPluginJsonSchemaValue(validateIncumbent, mark('review-1'))).toBe(true);
        expect(isValidPluginJsonSchemaValue(validateNarrowed, mark('review-1'))).toBe(true);

        expect(isPluginCollectionSchemaWideningV1({ source: incumbent, target: current })).toBe(true);
        expect(resolvePluginCollectionContractAccessV1({ currentWriter: incumbent, requested: current })).toBe('writable');
        expect(isPluginCollectionSchemaWideningV1({ source: narrowed, target: current })).toBe(true);
    });

    it.each(['plain', 'e2ee'] as const)('round-trips durable mark and link displays beyond source text limits through the measured %s Collection envelope', (encryptionMode) => {
        const display = { title: 't'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1), scopeLabel: 's'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1) };
        const entryRef = testkitEntryRef();
        const values = [
            {
                definition: CORPUS_SESSION_LINKS_COLLECTION,
                value: toCorpusStoredValue({
                    linkTag: `a${'2'.repeat(42)}`, entryTag: `a${'3'.repeat(42)}`,
                    sessionId: 'retained-session', linkedAtMs: 1,
                    entryRef, identityEntryRef: entryRef, displayPathAtLink: display.title,
                }),
            },
            {
                definition: CORPUS_USER_MARKS_COLLECTION,
                value: toCorpusStoredValue({
                    markTag: `a${'1'.repeat(42)}`, pinned: true, markedAtMs: 1,
                    entryRef, displayAtMark: display,
                    originError: { entryRef, display },
                    originReview: { reviewId: 'review-1', findingIds: ['finding-1', 'finding-2'] },
                    fixPullRequests: { linked: [{ entryRef, displayAtLink: display, linkedAtMs: 1 }], dismissed: [] },
                }),
            },
        ];
        for (const { definition, value } of values) {
            const contract = admit(definition);
            const validate = compilePluginJsonSchema(contract.schema);
            expect(isValidPluginJsonSchemaValue(validate, value),
                `${definition.id}: ${JSON.stringify(describePluginJsonSchemaValueIssues(validate))}`).toBe(true);
            const material = encryptionMode === 'e2ee' ? testkitAccountMaterial(1) : null;
            const encoded = encodePluginCollectionLogicalValueV1({ contract, value, encryptionMode, material,
                isValidLogicalValue: candidate => isValidPluginJsonSchemaValue(validate, candidate),
                randomBytes: length => new Uint8Array(length).fill(3) });
            expect(encoded.status).toBe('encoded');
            if (encoded.status !== 'encoded') throw new Error(`Unexpected Collection refusal: ${encoded.reason}`);
            expect(new TextEncoder().encode(JSON.stringify(encoded.content)).byteLength)
                .toBeLessThanOrEqual(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes);
            const decoded = decodePluginCollectionLogicalRowV1({ contract, encryptionMode, material,
                row: { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content },
                parseStoredLogicalValue: candidate => isValidPluginJsonSchemaValue(validate, candidate) ? candidate : null });
            expect(decoded.status).toBe('decoded');
            if (decoded.status !== 'decoded') throw new Error(`Unexpected Collection read refusal: ${decoded.reason}`);
            expect(fromCorpusStoredRow(decoded).value).toEqual(value);
        }
    });

    it('accepts retained displays at pin, fix-PR and origin Action input and result schemas', () => {
        const display = { title: 't'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1), scopeLabel: 's'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1) };
        const entryRef = testkitEntryRef();
        const pin = { v: 1, pinned: true, entryRef, displayAtMark: display };
        const pins = { v: 1, pins: [{ entryRef, markedAtMs: 1, displayAtMark: display }] };
        const originError = { entryRef, display };
        const origin = { v: 1, entryRef, displayAtMark: display, originError };
        const readOrigin = { v: 1, originError };
        const fix = { v: 1, linked: true, entryRef, displayAtMark: display, fixPullRequest: entryRef, displayAtLink: display };
        const candidate = { entryRef, origins: ['user'], status: 'unknown', display };
        const fixes = { v: 1, candidates: [candidate], primary: candidate, incomplete: false };
        const results = [
            [TriageSetEntryPinnedInputV1Schema, pin],
            [TriageListPinnedEntriesResultV1Schema, pins],
            [TriageSetTaskOriginErrorInputV1Schema, origin],
            [TriageReadTaskOriginErrorResultV1Schema, readOrigin],
            [TriageSetFixPullRequestInputV1Schema, fix],
            [TriageReadFixPullRequestsResultV1Schema, fixes],
        ] as const;
        for (const [schema, value] of results) expect(schema.parse(value)).toEqual(value);
    });

    it('declares exactly three Account Collections and no provider-derived durable store', () => {
        // Asserted over the manifest's declared contract rather than over sample
        // data: an unused-today collection is still an admitted durable store.
        const declared = PLUGIN_MANIFEST.contributes?.accountCollections ?? [];

        // An exact list, so declaring any further durable store — a provider
        // entry row, an observation row, a refresh-health row, a detail cache —
        // fails here rather than passing as an addition.
        expect(declared.map((definition) => definition.id)).toEqual([
            'source-instances',
            'session-links',
            'user-marks',
        ]);
    });

    it('admits every declared collection through the canonical contract normalizer', () => {
        const admitted = CORPUS_ACCOUNT_COLLECTIONS.map((definition) => admit(definition));

        expect(admitted.map((contract) => contract.collectionId)).toEqual([
            'source-instances',
            'session-links',
            'user-marks',
        ]);
        for (const contract of admitted) {
            expect(contract.contractDigest).toMatch(/^[A-Za-z0-9_-]+$/);
        }
        expect(admitted.map((contract) => contract.schemaVersion)).toEqual([4, 2, 3]);
    });

    it('keeps the preceding mark contract readable without projecting the new private origin', () => {
        const current = admit(CORPUS_USER_MARKS_COLLECTION);
        // Constructed preceding declaration: the observed v2 schema before T8
        // has identical members except for the optional originError property.
        const declaration = projectPluginAccountCollectionDeclaration(CORPUS_USER_MARKS_COLLECTION.id, CORPUS_USER_MARKS_COLLECTION);
        const preceding = normalizePluginAccountCollectionContractV1({
            pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
            contribution: PluginAccountCollectionContributionV1Schema.parse({ ...declaration,
                schema: { ...declaration.schema, properties: Object.fromEntries(
                    Object.entries(declaration.schema.properties ?? {}).filter(([field]) => field !== 'originError'),
                ) },
            }),
        });
        expect(resolvePluginCollectionContractAccessV1({ currentWriter: current, requested: preceding })).toBe('readOnly');
        expect(resolvePluginCollectionContractAccessV1({ currentWriter: preceding, requested: current })).toBe('readOnly');
        expect(current.serverReadable).not.toContain('originError');
        expect(current.indexes.flatMap(index => index.fields.map(field => field.field))).not.toContain('originError');
    });

    it('preserves existing source configuration and user intent through the widening migrations', async () => {
        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            const contract = admit(definition);
            expect(contract.readableSchemaVersions).toEqual(definition.id === 'source-instances' ? [1, 2, 3, 4] : definition.id === 'user-marks' ? [1, 2, 3] : [1, 2]);
            const migrations = collectionMigrations[definition.id]!;
            expect(migrations.map(migration => [migration.fromSchemaVersion, migration.toSchemaVersion]))
                .toEqual(definition.id === 'source-instances' ? [[1, 2], [2, 3], [3, 4]] : definition.id === 'user-marks' ? [[1, 2], [2, 3]] : [[1, 2]]);
            const retained = definition.id === 'source-instances'
                ? toCorpusStoredValue({
                    instanceTag: `a${'0'.repeat(42)}`, sourceQualifiedId: 'happier.example.source/example-forge', lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
                    configured: { v: 1, instance: { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, sourceInstanceId: '00000000-0000-4000-8000-000000000001' },
                        binding: { purpose: 'triage-source', account: { service: { pluginId: 'happier.example.source', localId: 'accounts' }, accountId: 'retained-account' } },
                        localInstanceKey: 'retained-scope', configuration: { v: 1, token: 'retained-routing-token' }, locator: { v: 1, displayLabel: 'Retained source' } },
                })
                : definition.id === 'session-links'
                    ? toCorpusStoredValue({ linkTag: `a${'2'.repeat(42)}`, entryTag: `a${'3'.repeat(42)}`, sessionId: 'retained-session', linkedAtMs: 1, entryRef: testkitEntryRef(), identityEntryRef: testkitEntryRef(), displayPathAtLink: 'Retained issue' })
                    : toCorpusStoredValue({ markTag: `a${'1'.repeat(42)}`, pinned: true, markedAtMs: 1, entryRef: testkitEntryRef(), displayAtMark: { title: 'Retained issue', scopeLabel: 'example/repository' } });
            let migrated = retained;
            for (const migration of migrations) migrated = await migration.migrate(migrated, { currentRevision: 1 });
            expect(migrated).toEqual(retained);
            const validate = compilePluginJsonSchema(contract.schema);
            const valid = isValidPluginJsonSchemaValue(validate, migrated);
            expect(valid, `${definition.id}: ${JSON.stringify(describePluginJsonSchemaValueIssues(validate))}`).toBe(true);
        }
    });

    it('declares every mode-derived storage address and binds it into the admitted contract', () => {
        const expectedIdentityFields = [
            {
                id: 'source-instances',
                fields: [CORPUS_SOURCE_INSTANCES_COLLECTION.rowIdField],
            },
            {
                id: 'session-links',
                fields: [
                    CORPUS_SESSION_LINKS_COLLECTION.rowIdField,
                    'entryTag',
                ],
            },
            {
                id: 'user-marks',
                fields: [CORPUS_USER_MARKS_COLLECTION.rowIdField],
            },
        ];

        expect(CORPUS_ACCOUNT_COLLECTIONS.map((definition) => ({
            id: definition.id,
            fields: definition.identityFields,
        }))).toEqual(expectedIdentityFields);
        expect(PLUGIN_MANIFEST.contributes?.accountCollections).toEqual(CORPUS_ACCOUNT_COLLECTIONS.map((definition) => projectPluginAccountCollectionDeclaration(definition.id, definition)));

        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            const declared = admit(definition);
            const withoutIdentityFields = normalizePluginAccountCollectionContractV1({
                pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
                contribution: PluginAccountCollectionContributionV1Schema.parse({ ...projectPluginAccountCollectionDeclaration(definition.id, definition), identityFields: [] }),
            });
            expect(declared.contractDigest).not.toBe(withoutIdentityFields.contractDigest);
        }
    });

    it('holds no credential-shaped field in any durable row schema', () => {
        // Asserted over the declared schemas rather than over sample data: sample
        // data proves nothing about a field that is merely unused today.
        const credentialShaped = /token|secret|credential|password|authoriz|bearer|cookie|apikey|privatekey|accesskey/i;
        const offenders: string[] = [];
        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            const names = collectSchemaMemberNames(definition.schema as JsonSchemaNode, new Set<string>());
            for (const name of names) {
                if (credentialShaped.test(name)) offenders.push(`${definition.id}.${name}`);
            }
        }

        // The only admitted exception is the source-owned opaque configuration
        // token, which the published contract binds to carry no credential and
        // no filesystem path and which the aggregate never parses.
        expect(offenders.sort()).toEqual(['source-instances.token']);
    });

  it('projects only the declared disclosure ledger for every collection', () => {
        expect(CORPUS_SOURCE_INSTANCES_COLLECTION.serverReadable)
            .toEqual(['sourceQualifiedId', 'lifecycle', 'configuredAtMs']);
        expect(CORPUS_SESSION_LINKS_COLLECTION.serverReadable)
            .toEqual(['entryTag', 'sessionId', 'linkedAtMs']);
        expect(CORPUS_USER_MARKS_COLLECTION.serverReadable).toEqual(['pinned', 'markedAtMs']);
  });

  it('admits the complete canonical public source contribution identity', () => {
    const source = PluginContributionIdentityV1Schema.parse({
      pluginId: `a.${'b'.repeat(254)}`,
      localId: 'c'.repeat(256),
    });
    const sourceQualifiedId = `${source.pluginId}/${source.localId}`;
    const schema = CORPUS_SOURCE_INSTANCES_COLLECTION.schema as Readonly<{
      properties: Readonly<Record<string, Readonly<{ maxLength?: number }>>>;
    }>;

    expect(schema.properties.sourceQualifiedId?.maxLength).toBe(sourceQualifiedId.length);
  });

    it('declares exactly the four indexes the disclosure ledger admits', () => {
        // An index is a disclosure, and index declarations are one-way once rows
        // exist: a "just in case" index is a defect rather than a tuning choice.
        expect(CORPUS_ACCOUNT_COLLECTIONS.flatMap((definition) => definition.indexes.map(
            (index) => `${definition.id}.${index.id}: ${index.fields.map((field) => `${field.field}:${field.direction}`).join(', ')}`,
        ))).toEqual([
            'source-instances.by-lifecycle: lifecycle:asc, configuredAtMs:asc',
            'session-links.by-entry: entryTag:asc',
            'session-links.by-session: sessionId:asc',
            'user-marks.by-pinned: pinned:asc, markedAtMs:desc',
        ]);
    });

    it('declares no per-index row quota', () => {
        // A per-source row quota is impossible — index prefix quotas carry
        // literal prefixes and a per-connection prefix is a runtime value — and
        // these collections grow only when a user configures a source, pins an
        // entry, or links a Session.
        for (const definition of CORPUS_ACCOUNT_COLLECTIONS) {
            expect(definition).not.toHaveProperty('quota');
        }
    });
});
