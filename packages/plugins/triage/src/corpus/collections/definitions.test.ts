import {
    PluginAccountCollectionContributionV1Schema,
    normalizePluginAccountCollectionContractV1,
} from '@happier-dev/protocol';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/host/registration';
import { describe, expect, it } from 'vitest';
import { compilePluginJsonSchema, describePluginJsonSchemaValueIssues } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { testkitEntryRef } from '../testkit/observations.test-support.js';
import { toCorpusStoredValue } from './rowCodec.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from './ids.js';

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
        expect(admitted.map((contract) => contract.schemaVersion)).toEqual([2, 1, 2]);
    });

    it('preserves existing source configuration and user intent through the widening migrations', async () => {
        for (const definition of [CORPUS_SOURCE_INSTANCES_COLLECTION, CORPUS_USER_MARKS_COLLECTION]) {
            const contract = admit(definition);
            expect(contract.readableSchemaVersions).toEqual([1, 2]);
            const migration = collectionMigrations[definition.id]![0]!;
            expect(migration).toMatchObject({ fromSchemaVersion: 1, toSchemaVersion: 2 });
            const retained = definition.id === 'source-instances'
                ? toCorpusStoredValue({
                    instanceTag: `a${'0'.repeat(42)}`, sourceQualifiedId: 'happier.example.source/example-forge', lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
                    configured: { v: 1, instance: { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, sourceInstanceId: '00000000-0000-4000-8000-000000000001' },
                        binding: { purpose: 'triage-source', account: { service: { pluginId: 'happier.example.source', localId: 'accounts' }, accountId: 'retained-account' } },
                        localInstanceKey: 'retained-scope', configuration: { v: 1, token: 'retained-routing-token' }, locator: { v: 1, displayLabel: 'Retained source' } },
                })
                : toCorpusStoredValue({ markTag: `a${'1'.repeat(42)}`, pinned: true, markedAtMs: 1, entryRef: testkitEntryRef(), displayAtMark: { title: 'Retained issue', scopeLabel: 'example/repository' } });
            const migrated = await migration.migrate(retained);
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
