import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import {
    PluginAccountCollectionContributionV1Schema,
    PluginMachineExecutionOriginV1JsonSchema as canonicalPluginMachineExecutionOriginV1JsonSchema,
} from '@happier-dev/protocol';
import {
    PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 as canonicalPluginCollectionMutationBatchMaxRowsV1,
    PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 as canonicalPluginCollectionQueryMaxRowsV1,
} from '@happier-dev/protocol/plugins/data/collectionLimitsV1';

import { PluginIdJsonSchema } from './manifest.js';
import {
    defineAccountCollection,
    PluginMachineExecutionOriginV1JsonSchema,
} from './collections.js';
import {
    defineAccountCollection as defineAccountCollectionFromPublicLeaf,
    PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
    PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
} from './collections/index.js';
import type {
    NormalizedPluginCollectionUiQueryDescriptorV1,
    PluginCollectionBatchAssert,
    PluginCollectionMutation,
    PluginCollectionUiQueryParameterV1,
    PluginCollectionUiQueryRequestV1,
    PluginCollectionUiQueryValueV1,
} from './collections.js';
import {
    defineProtocolObject,
    defineProtocolString,
    type PluginJsonSchema,
} from './protocol/index.js';
import type { PluginAccountCollectionValue } from './collections.js';
import type { JsonValue } from './identity.js';

// The source-only lane proves the author barrel itself. Generated inventory
// currentness remains owned by the one ordered publisher and is still required
// by every ordinary/package run.
const inventoryIt = process.env.HAPPIER_PLUGIN_SDK_SOURCE_ONLY === '1' ? it.skip : it;

describe('Account Collection declarations', () => {
    it('projects the canonical Protocol Collection bounds through the public author leaf', () => {
        expect(PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1)
            .toBe(canonicalPluginCollectionMutationBatchMaxRowsV1);
        expect(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1)
            .toBe(canonicalPluginCollectionQueryMaxRowsV1);
    });

    it('publishes the Account Collections author surface through its package subpath', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as Readonly<{
            exports: Readonly<Record<string, unknown>>;
        }>;

        expect(packageJson.exports['./collections']).toEqual({
            types: './dist/collections/index.d.ts',
            default: './dist/collections/index.js',
        });
    });

    inventoryIt('keeps the Collections barrel exactly aligned with its API inventory', async () => {
        const inventory = JSON.parse(
            await readFile(new URL('../api-surface.json', import.meta.url), 'utf8'),
        ) as Readonly<{
            symbols: readonly Readonly<{
                specifier: string;
                exportName: string;
            }>[];
        }>;
        const sourceModule = 'src/collections/index.ts';
        const sourceText = await readFile(new URL('./collections/index.ts', import.meta.url), 'utf8');
        const sourceFile = ts.createSourceFile(
            sourceModule,
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const barrelExports = sourceFile.statements.flatMap((statement) => {
            if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
            if (!ts.isNamedExports(statement.exportClause)) return [];
            return statement.exportClause.elements.map((element) => element.name.text);
        });
        const inventoryExports = inventory.symbols
            .filter(({ specifier }) => specifier === './collections')
            .map(({ exportName }) => exportName);

        expect(barrelExports).toContain('PluginCollectionBatchAssert');
        expect(inventoryExports).toContain('PluginCollectionBatchAssert');
        expect(barrelExports).toContain('PluginAccountCollectionMigration');
        expect(inventoryExports).toContain('PluginAccountCollectionMigration');
        expect([...barrelExports].sort()).toEqual([...inventoryExports].sort());
    });

    it('keeps exact-currentness assertions in the canonical Collection mutation union', () => {
        type Task = Readonly<{ id: string }>;

        expectTypeOf<Extract<PluginCollectionMutation<Task>, Readonly<{ kind: 'assert' }>>>()
            .toEqualTypeOf<PluginCollectionBatchAssert>();
    });

    it('preserves one typed static declaration for the Account storage service', () => {
        const tasks = defineAccountCollection({
            id: 'tasks',
            schemaVersion: 1,
            schema: defineProtocolObject({
                id: defineProtocolString(),
                title: defineProtocolString(),
            }, { policy: 'closed' }),
            rowIdField: 'id',
            identityFields: [],
            serverReadable: ['title'],
            indexes: [{ id: 'by-title', fields: [{ field: 'title', direction: 'asc' }] }],
            uiQueries: [],
            relations: [],
        });

        expect(tasks).toMatchObject({
            id: 'tasks',
            schemaVersion: 1,
            rowIdField: 'id',
            indexes: [{ id: 'by-title' }],
        });
        type ExpectedTask = Readonly<{
            readonly id: string;
            readonly title: string;
        }>;
        expectTypeOf<PluginAccountCollectionValue<typeof tasks>>().toMatchTypeOf<ExpectedTask>();
        expectTypeOf<ExpectedTask>().toMatchTypeOf<PluginAccountCollectionValue<typeof tasks>>();
    });

    it('keeps pure migration callbacks authorable through the public Collections leaf', () => {
        const tasks = defineAccountCollectionFromPublicLeaf({
            id: 'tasks',
            schemaVersion: 2,
            readableSchemaVersions: [1],
            schema: defineProtocolObject({
                id: defineProtocolString(),
                title: defineProtocolString(),
            }, { policy: 'closed' }),
            identityFields: [],
            serverReadable: ['title'],
            indexes: [{ id: 'by-title', fields: [{ field: 'title', direction: 'asc' }] }],
            migrations: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                migrate(value) {
                    expectTypeOf(value).toEqualTypeOf<Readonly<Record<string, JsonValue>>>();
                    return { id: String(value.id), title: String(value.title) };
                },
            }],
        });

        expect(tasks.migrations?.[0]?.migrate).toBeTypeOf('function');
    });

    it('passes lower-camel Collection members through the public author subpath to the canonical contract parser', () => {
        const tasks = defineAccountCollection({
            id: 'tasks',
            schemaVersion: 1,
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    dueAt: { type: 'string', format: 'date-time' },
                    projectId: { type: 'string' },
                    status: { type: 'string', enum: ['done', 'open'] },
                    title: { type: 'string' },
                },
                required: ['id', 'dueAt', 'projectId', 'status', 'title'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            identityFields: [],
            serverReadable: ['dueAt', 'projectId', 'status', 'title'],
            indexes: [{
                id: 'byProjectAndStatus',
                fields: [
                    { field: 'projectId', direction: 'asc' },
                    { field: 'status', direction: 'asc' },
                    { field: 'dueAt', direction: 'asc' },
                ],
            }],
            uiQueries: [{
                id: 'openByProject',
                indexId: 'byProjectAndStatus',
                parameters: { projectId: { kind: 'string', maxUtf8Bytes: 256 } },
                prefix: [
                    { kind: 'parameter', parameterId: 'projectId' },
                    { kind: 'literal', value: 'open' },
                ],
                order: 'asc',
                pageSize: 50,
                projectedFields: ['dueAt', 'status', 'title'],
            }],
            relations: [{
                id: 'project',
                kind: 'collection',
                field: 'projectId',
                collectionId: 'projects',
                required: true,
                onDelete: 'restrict',
            }],
        });

        expect(PluginAccountCollectionContributionV1Schema.safeParse(tasks).success).toBe(true);
    });

    it('accepts canonical public JSON-schema fragments in raw Collection declarations', () => {
        const pluginIdCollectionSchema = {
            type: 'object',
            properties: { id: PluginIdJsonSchema },
            required: ['id'],
            additionalProperties: false,
        } satisfies PluginJsonSchema;
        const pluginIds = defineAccountCollection({
            id: 'plugin-ids',
            schemaVersion: 1,
            schema: pluginIdCollectionSchema,
            rowIdField: 'id',
            identityFields: [],
            serverReadable: ['id'],
            indexes: [],
            uiQueries: [],
            relations: [],
        });

        expect(PluginAccountCollectionContributionV1Schema.safeParse(pluginIds).success).toBe(true);
    });

    it('preserves the raw author declaration instead of inventing parsed defaults', () => {
        const tasks = defineAccountCollection({
            id: 'tasks',
            schemaVersion: 1,
            schema: defineProtocolObject({
                id: defineProtocolString(),
            }, { policy: 'closed' }),
            identityFields: [],
            serverReadable: ['id'],
            indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
        });

        expectTypeOf<typeof tasks>().not.toHaveProperty('rowIdField');
        expectTypeOf<typeof tasks>().not.toHaveProperty('uiQueries');
        expectTypeOf<typeof tasks>().not.toHaveProperty('relations');
    });

    it('projects the canonical machine execution-origin JSON-schema fragment for collection declarations', () => {
        expect(PluginMachineExecutionOriginV1JsonSchema)
            .toBe(canonicalPluginMachineExecutionOriginV1JsonSchema);
    });

    it('projects the canonical Data UI-query types through the public Collections leaf', () => {
        type PublicDataUiQueryTypes = readonly [
            PluginCollectionUiQueryParameterV1,
            PluginCollectionUiQueryValueV1,
            PluginCollectionUiQueryRequestV1,
            NormalizedPluginCollectionUiQueryDescriptorV1,
        ];
        const publicDataUiQueryTypes: PublicDataUiQueryTypes | undefined = undefined;

        expect(publicDataUiQueryTypes).toBeUndefined();
    });
});
