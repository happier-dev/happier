import { describe, expect, it } from 'vitest';

import {
  PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
  PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
  PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
  PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
  PLUGIN_COLLECTION_LIMITS_V1,
  PLUGIN_COLLECTION_SCHEMA_VERSION_MAX,
  PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
  PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
  PluginAccountCollectionContributionV1Schema,
  PluginCollectionCandidatePreparationBindingV1Schema,
  PluginCollectionCandidatePreparationErrorV1Schema,
  PluginCollectionCandidatePreparationSourcePageRequestV1Schema,
  PluginCollectionCandidatePreparationSourcePageResultV1Schema,
  PluginCollectionCandidatePreparationStageRequestV1Schema,
  PluginCollectionCandidatePreparationStageResultV1Schema,
  PluginCollectionCandidatePreparationRetireRequestV1Schema,
  PluginCollectionCandidatePreparationRetireResultV1Schema,
  PluginCollectionContentEnvelopeV1Schema,
  assertPluginCollectionContentEnvelopeForModeV1,
  PluginCollectionContractReadResultV1Schema,
  PluginCollectionContractRefV1Schema,
  PluginCollectionGetRequestV1Schema,
  PluginCollectionGetResultV1Schema,
  PluginCollectionMemberNameV1Schema,
  PluginCollectionMigrationDeclarationV1Schema,
  PluginCollectionMutationErrorV1Schema,
  PluginCollectionMutationRequestV1Schema,
  PluginCollectionQuotaRequestV1Schema,
  PluginCollectionSchemaVersionV1Schema,
  PluginCollectionProjectionV1Schema,
  PluginCollectionQueryRequestV1Schema,
  PluginCollectionQueryResultV1Schema,
  PluginCollectionReadErrorCodeV1Schema,
  PluginCollectionReadErrorV1Schema,
  PluginCollectionRowIdV1Schema,
  PluginCollectionUiQueryErrorCodeV1Schema,
  PluginCollectionUiQueryErrorV1Schema,
  PluginCollectionUiQueryRequestV1Schema,
  PluginCollectionUiQueryResultV1Schema,
  PluginCollectionWriterContextV1Schema,
  openPluginCollectionPrivatePayloadV1,
  sealPluginCollectionPrivatePayloadV1,
  comparePluginCollectionIndexSortKeysV1,
  encodePluginCollectionIndexSortKeyV1,
  encodePluginCollectionIndexTuplePrefixV1,
  nextPluginCollectionIndexPrefixV1,
  measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
  measurePluginCollectionMutationRequestEncodedBytesV1,
  normalizePluginAccountCollectionContractV1,
  normalizePluginAccountCollectionContractsV1,
  splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1,
  validatePluginCollectionUiQueryParametersV1,
  validatePluginCollectionUiQueryResultV1,
} from './collectionsV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import {
  cloneStrictPluginJsonValue,
  measureSerializedStrictPluginJsonUtf8Bytes,
} from '../contributions/strictJsonValue.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '../contributions/catalog.js';
import { PluginContributesV2Schema } from '../contributions/v2.js';
import { MAX_PLUGIN_IDENTIFIER_BYTES } from '../pluginId.js';

const baseCollection = {
  id: 'tasks',
  schemaVersion: 1,
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 256 },
      status: { type: 'string', enum: ['open', 'closed'] },
      title: { type: 'string', maxLength: 256 },
    },
    required: ['id', 'status', 'title'],
    additionalProperties: false,
  },
  serverReadable: ['status', 'title'],
  indexes: [{
    id: 'by-status',
    fields: [
      { field: 'status', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  }],
  uiQueries: [{
    id: 'open',
    indexId: 'by-status',
    parameters: {
      status: { kind: 'string', maxUtf8Bytes: 16, enum: ['closed', 'open'] },
    },
    prefix: [{ kind: 'parameter', parameterId: 'status' }],
    order: 'asc',
    pageSize: 50,
    projectedFields: ['title', 'status'],
  }],
} as const;

describe('Plugin Account Collection contracts', () => {
  it('publishes the measured hard ceiling family without retaining the obsolete 256 KiB row limit', () => {
    expect(PLUGIN_COLLECTION_LIMITS_V1).toMatchObject({
      maximumStoredRowEncodedBytes: 2 * 1024 * 1024,
      maximumPrivateEnvelopeEncodedBytes: 512 * 1024,
      maximumProjectionEncodedBytes: 64 * 1024,
      maximumMutationBatchEncodedBytes: 64 * 1024 * 1024,
      maximumMutationBatchRows: 100,
      maximumAccountEncodedBytes: 1024 * 1024 * 1024,
      maximumAccountRows: 100_000,
    });

    const envelopeBaseBytes = JSON.stringify({ t: 'encrypted', c: '' }).length;
    expect(PluginCollectionContentEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'x'.repeat(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes - envelopeBaseBytes),
    }).success).toBe(true);
    expect(PluginCollectionContentEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'x'.repeat(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes - envelopeBaseBytes + 1),
    }).success).toBe(false);

    expect(PluginCollectionQuotaRequestV1Schema.safeParse({
      maxRowEncodedBytes: PLUGIN_COLLECTION_LIMITS_V1.maximumStoredRowEncodedBytes,
      maxRows: PLUGIN_COLLECTION_LIMITS_V1.maximumAccountRows,
      maxCollectionEncodedBytes: PLUGIN_COLLECTION_LIMITS_V1.maximumAccountEncodedBytes,
    }).success).toBe(true);
    expect(PluginCollectionQuotaRequestV1Schema.safeParse({
      maxRowEncodedBytes: PLUGIN_COLLECTION_LIMITS_V1.maximumStoredRowEncodedBytes + 1,
    }).success).toBe(false);
  });

  it('admits deeply nested valid Collection JSON that fits the private envelope ceiling', () => {
    // ~36 KiB of ordinary JSON nested well past the JavaScript call-stack depth
    // a recursive schema walk can carry. It is inside the published 512 KiB
    // private-envelope ceiling, so admission is the only thing under test.
    //
    // The size precondition deliberately uses Protocol's iterative serialized-byte
    // owner rather than `JSON.stringify`, whose depth limit is engine-specific and
    // is not a constant: Hermes refuses past 511 nesting levels, Firefox 146 past
    // 3,899, Node 24.14.0 past 6,173 (only 1,972 with 6,000 frames already on the
    // stack) and the macOS 26.3.1 system JavaScriptCore past 40,000, while Node 26
    // is iterative and refused nothing measurable. Measuring the precondition with
    // the host serializer would make this test's verdict depend on which engine
    // ran it instead of on envelope admission. The measured spread is recorded
    // with the Protocol strict-JSON owner.
    let nested: unknown = 1;
    for (let depth = 0; depth < 6_000; depth += 1) nested = { n: nested };
    const payload = { field: nested };
    const encodedBytes = measureSerializedStrictPluginJsonUtf8Bytes(
      cloneStrictPluginJsonValue(payload, 'value'),
      'value',
    );
    expect(encodedBytes).toBeGreaterThan(0);
    expect(encodedBytes).toBeLessThan(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes);

    const envelope = PluginCollectionContentEnvelopeV1Schema.parse({ t: 'plain', v: payload });
    expect(envelope.t).toBe('plain');

    // The same value one byte over the ceiling is still refused, so the
    // iterative admission did not become a hole in the envelope bound.
    const oversized = {
      field: nested,
      filler: 'x'.repeat(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes),
    };
    expect(PluginCollectionContentEnvelopeV1Schema.safeParse({ t: 'plain', v: oversized }).success)
      .toBe(false);
  });

  it('rejects a collection schema version the persisted integer column cannot hold', () => {
    expect(PluginCollectionSchemaVersionV1Schema.safeParse(PLUGIN_COLLECTION_SCHEMA_VERSION_MAX).success)
      .toBe(true);
    expect(PluginCollectionSchemaVersionV1Schema.safeParse(PLUGIN_COLLECTION_SCHEMA_VERSION_MAX + 1).success)
      .toBe(false);

    expect(PluginCollectionContractRefV1Schema.safeParse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      schemaVersion: PLUGIN_COLLECTION_SCHEMA_VERSION_MAX + 1,
      contractDigest: 'a'.repeat(43),
    }).success).toBe(false);

    expect(PluginCollectionMutationRequestV1Schema.safeParse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      writerContext: {
        schemaVersion: PLUGIN_COLLECTION_SCHEMA_VERSION_MAX + 1,
        contractDigest: 'a'.repeat(43),
      },
      operations: [{
        kind: 'put',
        rowId: 'row-1',
        expectedRevision: 'absent',
        content: { t: 'encrypted', c: 'ciphertext' },
        projection: { status: 'open' },
      }],
    }).success).toBe(false);
  });

  it('measures the complete parsed mutation request once for deployment batch policy', () => {
    const request = PluginCollectionMutationRequestV1Schema.parse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      writerContext: { schemaVersion: 1, contractDigest: 'a'.repeat(43) },
      operations: [{
        kind: 'put',
        rowId: 'row-1',
        expectedRevision: 'absent',
        content: { t: 'encrypted', c: 'ciphertext' },
        projection: { status: 'open' },
      }],
    });
    expect(measurePluginCollectionMutationRequestEncodedBytesV1(request)).toBe(
      new TextEncoder().encode(JSON.stringify(request)).byteLength,
    );
  });

  it('uses one exact error schema for direct and static Collection reads', () => {
    expect(PluginCollectionReadErrorCodeV1Schema).toBe(PluginCollectionUiQueryErrorCodeV1Schema);
    expect(PluginCollectionReadErrorV1Schema).toBe(PluginCollectionUiQueryErrorV1Schema);
  });

  it('uses one lower-camel Collection-member grammar across author, persisted, direct, and UI readers', () => {
    expect(PluginCollectionMemberNameV1Schema.safeParse('projectId').success).toBe(true);
    expect(PluginCollectionMemberNameV1Schema.safeParse('project-id').success).toBe(true);
    expect(PluginCollectionMemberNameV1Schema.safeParse('a'.repeat(MAX_PLUGIN_IDENTIFIER_BYTES + 1)).success).toBe(false);

    const contribution = {
      id: 'tasks',
      schemaVersion: 1,
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 256 },
          title: { type: 'string', maxLength: 256 },
          status: { type: 'string', enum: ['done', 'open'] },
          dueAt: { type: 'string', format: 'date-time', maxLength: 64 },
          projectId: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'title', 'status', 'dueAt', 'projectId'],
        additionalProperties: false,
      },
      rowIdField: 'id',
      serverReadable: ['title', 'status', 'dueAt', 'projectId'],
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
        projectedFields: ['title', 'status', 'dueAt'],
      }],
      relations: [{
        id: 'project',
        kind: 'collection',
        field: 'projectId',
        collectionId: 'projects',
        required: true,
        onDelete: 'restrict',
      }],
    } as const;

    const author = PluginAccountCollectionContributionV1Schema.safeParse(contribution);
    expect(author.success).toBe(true);
    if (!author.success) return;

    const normalized = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.projects-tasks',
      contribution: author.data,
    });
    expect(normalized).toMatchObject({
      rowIdField: 'id',
      serverReadable: ['dueAt', 'projectId', 'status', 'title'],
      indexes: [{ id: 'byProjectAndStatus' }],
      uiQueries: [{
        id: 'openByProject',
        indexId: 'byProjectAndStatus',
        parameters: { projectId: { kind: 'string', maxUtf8Bytes: 256 } },
        projectedFields: [
          { field: 'dueAt', kind: 'instant' },
          { field: 'status', kind: 'string' },
          { field: 'title', kind: 'string' },
        ],
      }],
      relations: [{ id: 'project', field: 'projectId', collectionId: 'projects' }],
    });

    expect(PluginCollectionContractReadResultV1Schema.safeParse({ contract: normalized }).success).toBe(true);
    expect(PluginCollectionQueryRequestV1Schema.safeParse({
      pluginId: normalized.pluginId,
      collectionId: normalized.collectionId,
      indexId: 'byProjectAndStatus',
      order: 'asc',
    }).success).toBe(true);
    expect(PluginCollectionUiQueryRequestV1Schema.safeParse({
      pluginId: normalized.pluginId,
      collectionId: normalized.collectionId,
      uiQueryId: 'openByProject',
      parameters: { projectId: 'project-1' },
    }).success).toBe(true);
    expect(PluginCollectionProjectionV1Schema.safeParse({
      title: 'Ship member-name grammar',
      status: 'open',
      dueAt: '2026-08-12T09:00:00.000Z',
      projectId: 'project-1',
    }).success).toBe(true);
    expect(PluginCollectionUiQueryResultV1Schema.safeParse({
      rows: [{
        context: {
          collection: { pluginId: normalized.pluginId, collectionId: normalized.collectionId },
          rowId: 'task-1',
          revision: 1,
        },
        fields: {
          title: 'Ship member-name grammar',
          status: 'open',
          dueAt: '2026-08-12T09:00:00.000Z',
        },
      }],
      changeCursor: 0,
    }).success).toBe(true);

    // Collection contribution identities retain the lower-case contribution-id grammar.
    expect(PluginAccountCollectionContributionV1Schema.safeParse({
      ...contribution,
      id: 'projectTasks',
    }).success).toBe(false);

    for (const invalidMemberName of [
      '',
      'project_id',
      'project/id',
      'projeçtId',
      'ProjectId',
      '1projectId',
      '-projectId',
      'projectId-',
      'project--id',
    ]) {
      expect(PluginCollectionUiQueryRequestV1Schema.safeParse({
        pluginId: normalized.pluginId,
        collectionId: normalized.collectionId,
        uiQueryId: invalidMemberName,
        parameters: { projectId: 'project-1' },
      }).success).toBe(false);
      expect(PluginCollectionProjectionV1Schema.safeParse({
        [invalidMemberName]: 'invalid',
      }).success).toBe(false);
      expect(PluginCollectionContentEnvelopeV1Schema.safeParse({
        t: 'plain',
        v: { [invalidMemberName]: 'invalid' },
      }).success).toBe(false);
      expect(PluginCollectionQueryRequestV1Schema.safeParse({
        pluginId: normalized.pluginId,
        collectionId: normalized.collectionId,
        indexId: invalidMemberName,
        order: 'asc',
      }).success).toBe(false);
      expect(PluginCollectionContractReadResultV1Schema.safeParse({
        contract: { ...normalized, rowIdField: invalidMemberName },
      }).success).toBe(false);
    }

    expect(PluginAccountCollectionContributionV1Schema.safeParse({
      ...contribution,
      schema: {
        ...contribution.schema,
        properties: {
          ...contribution.schema.properties,
          project_id: { type: 'string', maxLength: 256 },
        },
      },
    }).success).toBe(false);
    expect(PluginAccountCollectionContributionV1Schema.safeParse({
      ...contribution,
      schema: {
        ...contribution.schema,
        required: [...contribution.schema.required, 'project_id'],
      },
    }).success).toBe(false);
  });

  it('applies the member grammar only to top-level Collection fields', () => {
    const contribution = {
      ...baseCollection,
      schema: {
        ...baseCollection.schema,
        properties: {
          ...baseCollection.schema.properties,
          metadata: {
            type: 'object',
            properties: {
              external_key: { type: 'string' },
            },
            required: ['external_key'],
            additionalProperties: false,
          },
        },
      },
    } as const;

    expect(PluginAccountCollectionContributionV1Schema.safeParse(contribution).success).toBe(true);
    const normalized = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution,
    });
    expect(PluginCollectionContractReadResultV1Schema.safeParse({ contract: normalized }).success).toBe(true);
  });

  it('normalizes only object-root Collection schemas', () => {
    expect(normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: baseCollection,
    }).schema.type).toBe('object');

    for (const schema of [
      { type: 'null' },
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ] as const) {
      expect(() => normalizePluginAccountCollectionContractV1({
        pluginId: 'example.tasks',
        contribution: { ...baseCollection, schema },
      })).toThrow('Collection schemas must be object schemas with declared properties.');
    }
  });

  it('accepts same-kind literal-union indexed scalars and rejects mixed or non-scalar unions', () => {
    const normalizeWithStatus = (status: unknown, parameterKind: 'string' | 'finiteNumber' | 'boolean') => (
      normalizePluginAccountCollectionContractV1({
        pluginId: 'example.tasks',
        contribution: {
          ...baseCollection,
          schema: {
            ...baseCollection.schema,
            properties: {
              ...baseCollection.schema.properties,
              status,
            },
          },
          uiQueries: [{
            ...baseCollection.uiQueries[0],
            parameters: {
              status: parameterKind === 'string'
                ? { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] }
                : { kind: parameterKind },
            },
          }],
        },
      })
    );

    expect(() => normalizeWithStatus({ anyOf: [{ const: 'open' }, { const: 'closed' }] }, 'string')).not.toThrow();
    expect(() => normalizeWithStatus({ anyOf: [{ const: 1 }, { const: 2 }] }, 'finiteNumber')).not.toThrow();
    expect(() => normalizeWithStatus({ anyOf: [{ const: true }, { const: false }] }, 'boolean')).not.toThrow();

    expect(() => normalizeWithStatus({ anyOf: [{ const: 'open' }, { const: 2 }] }, 'string')).toThrow('not a supported scalar');
    expect(() => normalizeWithStatus({ anyOf: [{ const: 'open' }, { type: 'object', properties: {}, additionalProperties: false }] }, 'string')).toThrow('not a supported scalar');
  });

  it('rejects persisted Collection contracts whose schema root is not an object', () => {
    const normalized = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: baseCollection,
    });

    for (const schema of [
      { type: 'null' },
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
    ] as const) {
      expect(PluginCollectionContractReadResultV1Schema.safeParse({
        contract: {
          pluginId: normalized.pluginId,
          collectionId: normalized.collectionId,
          schemaVersion: normalized.schemaVersion,
          contractDigest: normalized.contractDigest,
          rowIdField: normalized.rowIdField,
          schema,
          serverReadable: normalized.serverReadable,
          indexes: normalized.indexes,
          uiQueries: normalized.uiQueries,
          relations: normalized.relations,
          readableSchemaVersions: normalized.readableSchemaVersions,
        },
      }).success).toBe(false);
    }
  });

  it('rejects NUL only in row identities while preserving bounded Unicode and indexed-string escaping', () => {
    const nonNulControlUnicodeRowId = 'café-\u0001東京';

    expect(PluginCollectionRowIdV1Schema.safeParse('row\u0000id').success).toBe(false);
    expect(PluginCollectionRowIdV1Schema.parse(nonNulControlUnicodeRowId))
      .toBe(nonNulControlUnicodeRowId);
    expect(Array.from(encodePluginCollectionIndexSortKeyV1({
      fields: [{ kind: 'string', value: 'before\u0000after' }],
      rowId: 'row',
    }))).toEqual([
      0x01,
      0x62, 0x65, 0x66, 0x6f, 0x72, 0x65,
      0x00, 0xff,
      0x61, 0x66, 0x74, 0x65, 0x72,
      0x00, 0x00,
      0x72, 0x6f, 0x77,
      0x00, 0x00,
    ]);
  });

  it('uses one raw ordinal byte encoding for the admitted worst compound key and its prefix bounds', () => {
    const allNulIndexedString = '\u0000'.repeat(256);
    const rowId = 'r'.repeat(256);
    const fields = Array.from({ length: 4 }, () => ({
      kind: 'string' as const,
      value: allNulIndexedString,
    }));

    const prefix = encodePluginCollectionIndexTuplePrefixV1({ fields });
    const sortKey = encodePluginCollectionIndexSortKeyV1({ fields, rowId });

    expect(prefix).toBeInstanceOf(Uint8Array);
    expect(prefix).toHaveLength(2_060);
    expect(sortKey).toBeInstanceOf(Uint8Array);
    expect(sortKey).toHaveLength(2_318);
    expect(Array.from(sortKey.subarray(0, 5))).toEqual([0x01, 0x00, 0xff, 0x00, 0xff]);
    expect(Array.from(sortKey.subarray(-4))).toEqual([0x72, 0x72, 0x00, 0x00]);

    const nul = encodePluginCollectionIndexSortKeyV1({
      fields: [{ kind: 'string', value: '\u0000' }],
      rowId: 'row-a',
    });
    const one = encodePluginCollectionIndexSortKeyV1({
      fields: [{ kind: 'string', value: '\u0001' }],
      rowId: 'row-b',
    });
    expect(comparePluginCollectionIndexSortKeysV1(nul, one)).toBeLessThan(0);
    expect(nextPluginCollectionIndexPrefixV1(Uint8Array.of(0x01, 0xff))).toEqual(Uint8Array.of(0x02));
    expect(nextPluginCollectionIndexPrefixV1(Uint8Array.of(0xff))).toBeNull();
  });

  it('encodes declared descending index fields in reverse scalar order without changing the row-ID tie-breaker', () => {
    const descendingKeys = [1, 2, 3].map((value) => ({
      value,
      key: encodePluginCollectionIndexSortKeyV1({
        fields: [{ kind: 'finiteNumber' as const, value, direction: 'desc' as const }],
        rowId: `row-${value}`,
      }),
    }));

    expect([...descendingKeys]
      .sort((left, right) => comparePluginCollectionIndexSortKeysV1(left.key, right.key))
      .map(({ value }) => value))
      .toEqual([3, 2, 1]);
  });

  it('rejects private envelopes, aggregate projections, and mutation batches above their fixed limits', () => {
    expect(PluginCollectionContentEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'x'.repeat(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes),
    }).success).toBe(false);

    expect(PluginCollectionProjectionV1Schema.safeParse(Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`field-${index}`, 'x'.repeat(4 * 1024)]),
    )).success).toBe(false);

    expect(PluginCollectionMutationRequestV1Schema.safeParse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      writerContext: { schemaVersion: 1, contractDigest: 'a'.repeat(43) },
      operations: Array.from({ length: PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows + 1 }, (_, index) => ({
        kind: 'put',
        rowId: `row-${index}`,
        expectedRevision: 'absent',
        content: { t: 'encrypted', c: 'x' },
        projection: {},
      })),
    }).success).toBe(false);
  });

  it('preserves a typed effective Collection quota incompatibility without widening other mutation errors', () => {
    const incompatible = {
      error: 'collection_quota_incompatible',
      dimension: 'maxAccountBytes',
      effectiveMaximum: 16_777_216,
    } as const;

    expect(PluginCollectionMutationErrorV1Schema.parse(incompatible)).toEqual(incompatible);
    expect(PluginCollectionMutationErrorV1Schema.safeParse({
      ...incompatible,
      unexpected: true,
    }).success).toBe(false);
    expect(PluginCollectionMutationErrorV1Schema.safeParse({
      error: 'collection_quota_incompatible',
      dimension: 'not-a-quota-dimension',
      effectiveMaximum: 1,
    }).success).toBe(false);
  });

  it('normalizes indexed-prefix quotas into one digest and rejects duplicate or over-limit declarations', () => {
    const contribution = {
      ...baseCollection,
      indexes: [
        ...baseCollection.indexes,
        {
          id: 'by-title',
          fields: [{ field: 'title', direction: 'desc' as const }],
        },
      ],
      quota: {
        maxRowsByIndexPrefix: [
          { indexId: 'by-title', prefix: ['Ship'], maxRows: 8 },
          { indexId: 'by-status', prefix: ['open'], maxRows: 32 },
        ],
      },
    } as const;
    const first = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution,
    });
    const equivalent = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: [...contribution.quota.maxRowsByIndexPrefix].reverse(),
        },
      },
    });
    const changed = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: contribution.quota.maxRowsByIndexPrefix.map((entry) => (
            entry.indexId === 'by-status' ? { ...entry, maxRows: 33 } : entry
          )),
        },
      },
    });

    expect(first).toEqual(equivalent);
    expect(first.quota?.maxRowsByIndexPrefix).toEqual([
      { indexId: 'by-status', prefix: ['open'], maxRows: 32 },
      { indexId: 'by-title', prefix: ['Ship'], maxRows: 8 },
    ]);
    expect(changed.contractDigest).not.toBe(first.contractDigest);
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: [
            ...contribution.quota.maxRowsByIndexPrefix,
            { indexId: 'by-status', prefix: ['open'], maxRows: 1 },
          ],
        },
      },
    })).toThrow('duplicate canonical');
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: [{ indexId: 'missing-index', prefix: ['open'], maxRows: 1 }],
        },
      },
    })).toThrow('unknown index');
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: [{ indexId: 'by-status', prefix: ['open', 'task-1'], maxRows: 1 }],
        },
      },
    })).not.toThrow();
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: [{ indexId: 'by-status', prefix: ['open', 'task-1', 'overlong'], maxRows: 1 }],
        },
      },
    })).toThrow('exceeds its declared fields');
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        quota: {
          maxRowsByIndexPrefix: [{ indexId: 'by-status', prefix: [1], maxRows: 1 }],
        },
      },
    })).toThrow('does not match its declared scalar fields');
    expect(PluginAccountCollectionContributionV1Schema.safeParse({
      ...contribution,
      quota: {
        maxRowsByIndexPrefix: Array.from({ length: 9 }, () => ({
          indexId: 'by-status',
          prefix: ['open'],
          maxRows: 1,
        })),
      },
    }).success).toBe(false);
    expect(PluginAccountCollectionContributionV1Schema.safeParse({
      ...contribution,
      quota: {
        maxRowsByIndexPrefix: [{
          indexId: 'by-status',
          prefix: ['open'],
          maxRows: 100_000,
        }],
      },
    }).success).toBe(true);
    expect(PluginAccountCollectionContributionV1Schema.safeParse({
      ...contribution,
      quota: {
        maxRowsByIndexPrefix: [{
          indexId: 'by-status',
          prefix: ['open'],
          maxRows: 100_001,
        }],
      },
    }).success).toBe(false);
  });

  it('admits live-row assertions only in batches that also mutate a row', () => {
    const request = {
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      writerContext: { schemaVersion: 1, contractDigest: 'a'.repeat(43) },
      operations: [
        { kind: 'assert', rowId: 'current-row', expectedRevision: 2 },
        {
          kind: 'put',
          rowId: 'next-row',
          expectedRevision: 'absent',
          content: { t: 'plain', v: {} },
          projection: {},
        },
      ],
    } as const;

    expect(PluginCollectionMutationRequestV1Schema.safeParse(request).success).toBe(true);
    expect(PluginCollectionMutationRequestV1Schema.safeParse({
      ...request,
      operations: [request.operations[0]],
    }).success).toBe(false);
    expect(PluginCollectionMutationRequestV1Schema.safeParse({
      ...request,
      operations: [{ ...request.operations[0], expectedRevision: 'absent' }],
    }).success).toBe(false);
  });

  it('seals an E2EE collection private payload in its exact Account-scoped domain', () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const payload = { privateNote: 'only the direct Account client can open this' };
    const randomBytes = (length: number) => new Uint8Array(length).fill(3);
    const ciphertext = sealPluginCollectionPrivatePayloadV1({
      material,
      payload,
      randomBytes,
    });

    expect(openPluginCollectionPrivatePayloadV1({ material, ciphertext })).toEqual(payload);
    expect(assertPluginCollectionContentEnvelopeForModeV1({
      t: 'encrypted',
      c: ciphertext,
    }, 'e2ee')).toEqual({ t: 'encrypted', c: ciphertext });

    const settingsCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'plugin_declarative_settings',
      material,
      payload,
      randomBytes,
    });
    expect(openPluginCollectionPrivatePayloadV1({
      material,
      ciphertext: settingsCiphertext,
    })).toBeNull();
    expect(() => assertPluginCollectionContentEnvelopeForModeV1({
      t: 'encrypted',
      c: settingsCiphertext,
    }, 'e2ee')).toThrow('Plugin Collection content envelope');
  });

  it('defines bounded generic get/query envelopes without caller-supplied contract authority', () => {
    const row = {
      rowId: 'task-1',
      revision: 2,
      content: { t: 'plain' as const, v: { id: 'task-1', title: 'Ship the adapter' } },
      projection: { status: 'open', title: 'Ship the adapter' },
    };

    expect(PluginCollectionGetRequestV1Schema.parse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      rowId: 'task-1',
    })).toEqual({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      rowId: 'task-1',
    });
    expect(PluginCollectionGetResultV1Schema.parse({ row })).toEqual({ row });
    expect(PluginCollectionGetResultV1Schema.parse({ row: null })).toEqual({ row: null });

    expect(PluginCollectionQueryRequestV1Schema.parse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      indexId: 'by-status',
      prefix: ['open'],
      range: { lower: 'a', upper: 'z' },
      order: 'asc',
      limit: 2,
    })).toEqual({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      indexId: 'by-status',
      prefix: ['open'],
      range: { lower: 'a', upper: 'z' },
      order: 'asc',
      limit: 2,
    });
    expect(PluginCollectionQueryRequestV1Schema.safeParse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      indexId: 'by-status',
      order: 'asc',
      contractDigest: 'forged-authority',
    }).success).toBe(false);
    expect(PluginCollectionQueryRequestV1Schema.safeParse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      indexId: 'by-status',
      order: 'asc',
      limit: 201,
    }).success).toBe(false);
    expect(PluginCollectionQueryResultV1Schema.parse({
      rows: [row],
      nextCursor: 'cursor',
      changeCursor: 4,
    })).toEqual({
      rows: [row],
      nextCursor: 'cursor',
      changeCursor: 4,
    });
    expect({
      get: PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
      mutate: PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
      query: PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    }).toEqual({
      get: '/v1/plugins/data/get',
      mutate: '/v1/plugins/data/mutate',
      query: '/v1/plugins/data/query',
    });
  });

  it('binds candidate preparation paging and bounded target-stage batches without granting a callback or activation authority', () => {
    const binding = {
      source: {
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        schemaVersion: 1,
        contractDigest: 'a'.repeat(43),
      },
      target: {
        pluginId: 'example.tasks',
        collectionId: 'tasks',
        schemaVersion: 2,
        contractDigest: 'b'.repeat(43),
      },
      candidate: {
        releaseVersion: '1.2.3',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
      },
    } as const;
    const sourceRow = {
      rowId: 'task-1',
      revision: 7,
      content: { t: 'encrypted' as const, c: 'source-ciphertext' },
      projection: { id: 'task-1', status: 'open', title: 'Ship the migration seam' },
      alreadyStaged: false,
    };

    expect(PluginCollectionCandidatePreparationBindingV1Schema.parse(binding)).toEqual(binding);
    expect(PluginCollectionCandidatePreparationBindingV1Schema.safeParse({
      ...binding,
      target: { ...binding.target, pluginId: 'another.plugin' },
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationBindingV1Schema.safeParse({
      ...binding,
      target: { ...binding.target, collectionId: 'other-tasks' },
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationBindingV1Schema.safeParse({
      ...binding,
      candidate: {
        releaseVersion: binding.candidate.releaseVersion,
        generationId: 'forged-daemon-immutable-generation',
      },
    }).success).toBe(false);

    expect(PluginCollectionCandidatePreparationSourcePageRequestV1Schema.parse({
      binding,
      cursor: 'opaque-source-page',
      limit: 200,
    })).toEqual({
      binding,
      cursor: 'opaque-source-page',
      limit: 200,
    });
    expect(PluginCollectionCandidatePreparationSourcePageRequestV1Schema.safeParse({
      binding,
      accountId: 'forged-account',
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationSourcePageRequestV1Schema.safeParse({
      binding,
      limit: 201,
    }).success).toBe(false);

    expect(PluginCollectionCandidatePreparationSourcePageResultV1Schema.parse({
      rows: [sourceRow],
      nextCursor: 'next-source-page',
    })).toEqual({
      rows: [sourceRow],
      nextCursor: 'next-source-page',
    });
    expect(PluginCollectionCandidatePreparationSourcePageResultV1Schema.safeParse({
      rows: [{ ...sourceRow, value: { id: 'task-1' } }],
    }).success).toBe(false);
    const { alreadyStaged, ...sourceRowWithoutStageFact } = sourceRow;
    expect(alreadyStaged).toBe(false);
    expect(PluginCollectionCandidatePreparationSourcePageResultV1Schema.safeParse({
      rows: [sourceRowWithoutStageFact],
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationSourcePageResultV1Schema.parse({
      rows: [{ ...sourceRow, alreadyStaged: true }],
    })).toEqual({
      rows: [{ ...sourceRow, alreadyStaged: true }],
    });

    const stageItems = [
      {
        source: { rowId: sourceRow.rowId, revision: sourceRow.revision },
        target: {
          content: { t: 'encrypted' as const, c: 'target-ciphertext' },
          projection: { id: 'task-1', status: 'open', title: 'Ship the migration seam' },
        },
      },
      {
        source: { rowId: 'task-2', revision: 8 },
        target: {
          content: { t: 'encrypted' as const, c: 'target-ciphertext-2' },
          projection: { id: 'task-2', status: 'closed', title: 'Verify the batch seam' },
        },
      },
    ];
    const stageRequest = { binding, items: stageItems };
    expect(PluginCollectionCandidatePreparationStageRequestV1Schema.parse(stageRequest))
      .toEqual(stageRequest);
    expect(PluginCollectionCandidatePreparationStageRequestV1Schema.safeParse({
      binding,
      source: { rowId: sourceRow.rowId, revision: sourceRow.revision },
      target: {
        content: { t: 'encrypted', c: 'target-ciphertext' },
        projection: { id: 'task-1', status: 'open' },
      },
      callback: 'forged-callback',
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationStageRequestV1Schema.safeParse({
      binding,
      items: [],
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationStageRequestV1Schema.safeParse({
      binding,
      items: Array.from(
        { length: PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows + 1 },
        () => stageItems[0],
      ),
    }).success).toBe(false);
    expect(measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(stageRequest)).toBe(
      new TextEncoder().encode(JSON.stringify(stageRequest)).byteLength,
    );

    const splitCandidateStageRequests = splitPluginCollectionCandidatePreparationStageRequestsForKnownLimitsV1;

    const maxSingletonBytes = Math.max(
      ...stageRequest.items.map((item) => (
        measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1({
          binding,
          items: [item],
        })
      )),
    );
    const byteLimitedRequests = splitCandidateStageRequests({
      binding,
      items: stageRequest.items,
      limits: { maxBatchRows: 100, maxBatchBytes: maxSingletonBytes },
    }) as readonly typeof stageRequest[];
    expect(byteLimitedRequests).toHaveLength(stageRequest.items.length);
    expect(byteLimitedRequests.flatMap((request) => request.items)).toEqual(stageRequest.items);
    expect(byteLimitedRequests.every((request) => (
      measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(request) <= maxSingletonBytes
    ))).toBe(true);

    const rowLimitedRequests = splitCandidateStageRequests({
      binding,
      items: stageRequest.items,
      limits: {
        maxBatchRows: 1,
        maxBatchBytes: measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(stageRequest),
      },
    }) as readonly typeof stageRequest[];
    expect(rowLimitedRequests.map((request) => request.items)).toEqual(
      stageRequest.items.map((item) => [item]),
    );

    const singleton = stageRequest.items[0]!;
    const singletonRequest = { binding, items: [singleton] };
    const singletonBytes = measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(singletonRequest);
    expect(splitCandidateStageRequests({
      binding,
      items: [singleton],
      limits: { maxBatchRows: 1, maxBatchBytes: singletonBytes - 1 },
    })).toEqual([singletonRequest]);

    const stageResult = { results: [{ status: 'staged' as const }, { status: 'sourceChanged' as const }] };
    expect(PluginCollectionCandidatePreparationStageResultV1Schema.parse(stageResult))
      .toEqual(stageResult);
    expect(PluginCollectionCandidatePreparationStageResultV1Schema.safeParse({ status: 'staged' }).success)
      .toBe(false);
    expect(PluginCollectionCandidatePreparationRetireRequestV1Schema.parse({ binding }))
      .toEqual({ binding });
    expect(PluginCollectionCandidatePreparationRetireRequestV1Schema.safeParse({
      binding,
      accountId: 'forged-account',
      reason: 'forged-reason',
      ttlMs: 1,
      readinessToken: 'forged-readiness',
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationRetireResultV1Schema.parse({ status: 'retired' }))
      .toEqual({ status: 'retired' });
    expect(PluginCollectionCandidatePreparationRetireResultV1Schema.safeParse({
      status: 'retired',
      stageCount: 1,
    }).success).toBe(false);
    expect(PluginCollectionCandidatePreparationErrorV1Schema.parse({
      error: 'collection_candidate_preparation_contract_mismatch',
    })).toEqual({ error: 'collection_candidate_preparation_contract_mismatch' });
    expect(PluginCollectionCandidatePreparationErrorV1Schema.parse({
      error: 'collection_quota_exceeded',
    })).toEqual({ error: 'collection_quota_exceeded' });
    expect(PluginCollectionCandidatePreparationErrorV1Schema.parse({
      error: 'collection_quota_incompatible',
      dimension: 'maxAccountBytes',
      effectiveMaximum: 1024,
    })).toEqual({
      error: 'collection_quota_incompatible',
      dimension: 'maxAccountBytes',
      effectiveMaximum: 1024,
    });
    expect(PluginCollectionCandidatePreparationErrorV1Schema.safeParse({
      error: 'collection_candidate_preparation_contract_mismatch',
      activation: 'forged',
    }).success).toBe(false);

    expect({
      sourcePage: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
      stage: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
      retire: PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    }).toEqual({
      sourcePage: '/v1/plugins/data/candidate-preparation/source-page',
      stage: '/v1/plugins/data/candidate-preparation/stage',
      retire: '/v1/plugins/data/candidate-preparation/retire',
    });
  });

  it('normalizes equivalent static UI query declarations into one immutable digest', () => {
    const first = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: baseCollection,
    });
    const equivalent = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...baseCollection,
        rowIdField: 'id',
        serverReadable: ['title', 'status'],
        schema: {
          ...baseCollection.schema,
          properties: {
            title: { type: 'string', maxLength: 256 },
            id: { maxLength: 256, type: 'string' },
            status: { enum: ['open', 'closed'], type: 'string' },
          },
          required: ['title', 'id', 'status'],
        },
        uiQueries: [{
          ...baseCollection.uiQueries[0],
          projectedFields: ['status', 'title'],
          parameters: {
            status: { kind: 'string', enum: ['open', 'closed'], maxUtf8Bytes: 16 },
          },
        }],
      },
    });

    expect(first).toEqual(equivalent);
    expect(first.contractDigest).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.uiQueries[0]).toMatchObject({
      collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
      id: 'open',
      indexId: 'by-status',
      projectedFields: [
        { field: 'status', kind: 'string' },
        { field: 'title', kind: 'string' },
      ],
    });
  });

  it('uses locale-independent ordinal ordering for canonical contract text', () => {
    const normalized = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...baseCollection,
        schema: {
          ...baseCollection.schema,
          properties: {
            ...baseCollection.schema.properties,
            accent: { type: 'string', enum: ['ä', 'z'] },
            z: { type: 'string' },
          },
        },
      },
    });

    expect(Object.keys(normalized.schema.properties ?? {})).toEqual(['accent', 'id', 'status', 'title', 'z']);
    expect(normalized.schema.properties?.accent).toMatchObject({ enum: ['z', 'ä'] });
  });

  it('changes the digest for UI-query semantics and rejects unavailable or open query authority', () => {
    const first = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: baseCollection,
    });
    const changed = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...baseCollection,
        uiQueries: [{ ...baseCollection.uiQueries[0], pageSize: 25 }],
      },
    });

    expect(changed.contractDigest).not.toBe(first.contractDigest);
    const reversedIndex = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...baseCollection,
        indexes: [{
          ...baseCollection.indexes[0],
          fields: [
            { field: 'status', direction: 'desc' },
            { field: 'id', direction: 'asc' },
          ],
        }],
      },
    });
    expect(reversedIndex.contractDigest).not.toBe(first.contractDigest);
    expect(() => PluginAccountCollectionContributionV1Schema.parse({
      ...baseCollection,
      uiQueries: [{
        ...baseCollection.uiQueries[0],
        parameters: { filter: { kind: 'object' } },
      }],
    })).toThrow();
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...baseCollection,
        uiQueries: [{ ...baseCollection.uiQueries[0], indexId: 'unknown' }],
      },
    })).toThrow('unknown index');
    expect(() => PluginCollectionUiQueryRequestV1Schema.parse({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
    })).toThrow();
    expect(() => PluginCollectionUiQueryRequestV1Schema.parse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: { status: 'open' },
      contractDigest: 'caller-authority-is-forbidden',
    })).toThrow();
  });

  it('admits account collections through the sole manifest family catalog without a runtime registration right', () => {
    const contributes = PluginContributesV2Schema.parse({
      accountCollections: [baseCollection],
    });
    const catalog = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'accountCollections');

    expect(contributes.accountCollections).toEqual([
      expect.objectContaining({ id: 'tasks', rowIdField: 'id' }),
    ]);
    expect(catalog).toMatchObject({
      identityField: 'id',
      activationDemand: 'none',
      allowedRuntimeRegistration: null,
      consumer: 'account-collection-service',
    });
    expect(() => PluginContributesV2Schema.parse({
      accountCollections: [baseCollection, { ...baseCollection, schemaVersion: 2 }],
    })).toThrow('Duplicate account collection contribution id');
  });

  it('normalizes one plugin collection set into stable qualified contract references', () => {
    const contracts = normalizePluginAccountCollectionContractsV1({
      pluginId: 'example.tasks',
      contributions: [
        { ...baseCollection, id: 'notes' },
        baseCollection,
      ],
    });

    expect(contracts.map((contract) => contract.collectionId)).toEqual(['notes', 'tasks']);
    expect(contracts.map((contract) => contract.contractDigest)).toHaveLength(2);
    expect(() => normalizePluginAccountCollectionContractsV1({
      pluginId: 'example.tasks',
      contributions: [baseCollection, { ...baseCollection, schemaVersion: 2 }],
    })).toThrow('Duplicate account collection contribution id');
  });

  it('admits only the exact unpadded SHA-256 digest shape for reader and writer contracts', () => {
    const digest = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: baseCollection,
    }).contractDigest;

    expect(digest).toHaveLength(43);
    expect(PluginCollectionContractRefV1Schema.parse({
      pluginId: 'example.tasks',
      collectionId: 'tasks',
      schemaVersion: 1,
      contractDigest: digest,
    }).contractDigest).toBe(digest);
    expect(PluginCollectionWriterContextV1Schema.safeParse({
      schemaVersion: 1,
      contractDigest: digest.slice(0, -1),
    }).success).toBe(false);
    expect(PluginCollectionWriterContextV1Schema.safeParse({
      schemaVersion: 1,
      contractDigest: `${digest}=`,
    }).success).toBe(false);
  });

  it('accepts only a declared scalar projection in static UI-query results', () => {
    const descriptor = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: baseCollection,
    }).uiQueries[0]!;
    const response = {
      rows: [{
        context: {
          collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
          rowId: 'task-1',
          revision: 3,
        },
        fields: { status: 'open', title: 'Ship the adapter' },
      }],
      changeCursor: 42,
    };

    expect(PluginCollectionUiQueryResultV1Schema.parse(response)).toEqual(response);
    expect(validatePluginCollectionUiQueryResultV1(descriptor, response).rows).toHaveLength(1);
    expect(() => validatePluginCollectionUiQueryResultV1(descriptor, {
      ...response,
      rows: [{
        ...response.rows[0],
        fields: { ...response.rows[0].fields, 'private-payload': 'must not cross the boundary' },
      }],
    })).toThrow('undeclared field');
    expect(() => validatePluginCollectionUiQueryResultV1(descriptor, {
      ...response,
      rows: [{
        ...response.rows[0],
        context: {
          ...response.rows[0].context,
          collection: { pluginId: 'example.other', collectionId: 'tasks' },
        },
      }],
    })).toThrow('different collection');
  });

  it('rejects parseable but non-canonical indexed instants before they alias an ordinal key', () => {
    const descriptor = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.events',
      contribution: {
        ...baseCollection,
        id: 'events',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 256 },
            'occurred-at': { type: 'string', format: 'date-time' },
          },
          required: ['id', 'occurred-at'],
          additionalProperties: false,
        },
        serverReadable: ['occurred-at'],
        indexes: [{
          id: 'by-occurred-at',
          fields: [{ field: 'occurred-at', direction: 'asc' }],
        }],
        uiQueries: [{
          id: 'at',
          indexId: 'by-occurred-at',
          parameters: { at: { kind: 'instant' } },
          prefix: [{ kind: 'parameter', parameterId: 'at' }],
          order: 'asc',
          pageSize: 1,
          projectedFields: ['occurred-at'],
        }],
      },
    }).uiQueries[0]!;

    expect(() => validatePluginCollectionUiQueryParametersV1(descriptor, {
      at: '2026-01-02T03:04:05Z',
    })).toThrow('invalid');
    expect(() => validatePluginCollectionUiQueryParametersV1(descriptor, {
      at: '2026-01-02T03:04:05.000Z',
    })).not.toThrow();

    const impossibleInstant = '2024-02-30T00:00:00.000Z';
    const canonicalInstant = '2024-03-01T00:00:00.000Z';
    // ECMAScript normalizes this impossible calendar date to the same epoch
    // as March 1. Both the static query validator and the direct index
    // encoder must reject it before that alias can enter a query bound/key.
    expect(Date.parse(impossibleInstant)).toBe(Date.parse(canonicalInstant));
    expect(() => validatePluginCollectionUiQueryParametersV1(descriptor, {
      at: impossibleInstant,
    })).toThrow('invalid');
    expect(() => encodePluginCollectionIndexSortKeyV1({
      fields: [{ kind: 'instant', value: impossibleInstant }],
      rowId: 'event-1',
    })).toThrow('Indexed instant does not match its scalar kind.');

    expect(() => encodePluginCollectionIndexSortKeyV1({
      fields: [{ kind: 'instant', value: canonicalInstant }],
      rowId: 'event-1',
    })).not.toThrow();
  });

  it('includes relation, quota, and readable-version semantics in the immutable contract', () => {
    const withRelation = {
      ...baseCollection,
      schemaVersion: 2,
      schema: {
        ...baseCollection.schema,
        properties: {
          ...baseCollection.schema.properties,
          project: { type: 'string', maxLength: 256 },
        },
        required: [...baseCollection.schema.required, 'project'],
      },
      serverReadable: [...baseCollection.serverReadable, 'project'],
      indexes: [
        ...baseCollection.indexes,
        {
          id: 'by-project',
          fields: [
            { field: 'project', direction: 'asc' },
            { field: 'id', direction: 'asc' },
          ],
        },
      ],
      readableSchemaVersions: [1],
      migrations: [{ id: 'upgrade-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 }],
      quota: { maxRows: 100 },
      relations: [{
        id: 'project',
        kind: 'collection',
        field: 'project',
        collectionId: 'projects',
        required: true,
        onDelete: 'restrict',
      }],
    } as const;
    const first = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: withRelation,
    });
    const changedQuota = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: { ...withRelation, quota: { maxRows: 101 } },
    });

    expect(first.readableSchemaVersions).toEqual([1, 2]);
    expect(first.relations).toEqual([expect.objectContaining({ id: 'project', collectionId: 'projects' })]);
    expect(changedQuota.contractDigest).not.toBe(first.contractDigest);
    expect(() => PluginAccountCollectionContributionV1Schema.parse({
      ...withRelation,
      relations: [{ ...withRelation.relations[0], onDelete: 'nullify' }],
    })).toThrow('Required collection relations cannot nullify');
    expect(() => PluginAccountCollectionContributionV1Schema.parse({
      ...withRelation,
      relations: [
        withRelation.relations[0],
        { ...withRelation.relations[0], id: 'project-alias' },
      ],
    })).toThrow('Relation fields must be unique');
    expect(() => normalizePluginAccountCollectionContractsV1({
      pluginId: 'example.tasks',
      contributions: [withRelation],
    })).toThrow('targets undeclared collection');
  });

  it('requires the exact ordered static migration chain for admitted readable versions', () => {
    const evolvingCollection = {
      ...baseCollection,
      schemaVersion: 3,
      readableSchemaVersions: [1, 2],
      migrations: [
        { id: 'upgrade-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 },
        { id: 'upgrade-v2-to-v3', fromSchemaVersion: 2, toSchemaVersion: 3 },
      ],
    } as const;

    const normalized = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: evolvingCollection,
    });
    const changedIdentity = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...evolvingCollection,
        migrations: [
          { ...evolvingCollection.migrations[0], id: 'upgrade-v1-to-v2-revised' },
          evolvingCollection.migrations[1],
        ],
      },
    });

    expect(normalized.migrations).toEqual(evolvingCollection.migrations);
    expect(changedIdentity.contractDigest).not.toBe(normalized.contractDigest);
    for (const migrations of [
      [evolvingCollection.migrations[0]],
      [evolvingCollection.migrations[1], evolvingCollection.migrations[0]],
      [evolvingCollection.migrations[0], evolvingCollection.migrations[0], evolvingCollection.migrations[1]],
      [{ id: 'upgrade-v1-to-v3', fromSchemaVersion: 1, toSchemaVersion: 3 }],
      [...evolvingCollection.migrations, { id: 'upgrade-v3-to-v4', fromSchemaVersion: 3, toSchemaVersion: 4 }],
    ]) {
      expect(() => normalizePluginAccountCollectionContractV1({
        pluginId: 'example.tasks',
        contribution: { ...evolvingCollection, migrations },
      })).toThrow(/migration/i);
    }
  });

  it('admits only host references with canonical Account-scoped identities', () => {
    const hostRelation = {
      ...baseCollection,
      relations: [{
        id: 'host-target',
        kind: 'host',
        field: 'status',
        hostKind: 'machine',
      }],
    } as const;

    for (const hostKind of [
      'account',
      'machine',
      'session',
      'message',
      'artifact',
      'connectedAccount',
    ]) {
      expect(PluginAccountCollectionContributionV1Schema.safeParse({
        ...hostRelation,
        relations: [{ ...hostRelation.relations[0], hostKind }],
      }).success).toBe(true);
    }

    for (const hostKind of ['project', 'workspace']) {
      expect(PluginAccountCollectionContributionV1Schema.safeParse({
        ...hostRelation,
        relations: [{ ...hostRelation.relations[0], hostKind }],
      }).success).toBe(false);
    }
  });

  it('normalizes an omitted relation uniqueness flag to its explicit false semantic value', () => {
    const contribution = {
      ...baseCollection,
      schema: {
        ...baseCollection.schema,
        properties: {
          ...baseCollection.schema.properties,
          project: { type: 'string', maxLength: 256 },
        },
        required: [...baseCollection.schema.required, 'project'],
      },
      serverReadable: [...baseCollection.serverReadable, 'project'],
      indexes: [
        ...baseCollection.indexes,
        {
          id: 'by-project',
          fields: [
            { field: 'project', direction: 'asc' },
            { field: 'id', direction: 'asc' },
          ],
        },
      ],
      relations: [{
        id: 'project',
        kind: 'collection',
        field: 'project',
        collectionId: 'projects',
        required: true,
        onDelete: 'restrict',
      }],
    } as const;
    const implicit = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution,
    });
    const explicitFalse = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...contribution,
        relations: [{ ...contribution.relations[0], unique: false }],
      },
    });

    expect(implicit.contractDigest).toBe(explicitFalse.contractDigest);
    expect(implicit.relations).toEqual([
      expect.objectContaining({ id: 'project', unique: false }),
    ]);
  });

  it('requires an index whose leading field can page a restricted relation\'s dependents', () => {
    expect(() => normalizePluginAccountCollectionContractV1({
      pluginId: 'example.tasks',
      contribution: {
        ...baseCollection,
        schema: {
          ...baseCollection.schema,
          properties: {
            ...baseCollection.schema.properties,
            project: { type: 'string', maxLength: 256 },
          },
          required: [...baseCollection.schema.required, 'project'],
        },
        serverReadable: [...baseCollection.serverReadable, 'project'],
        relations: [{
          id: 'project',
          kind: 'collection',
          field: 'project',
          collectionId: 'projects',
          required: true,
          onDelete: 'restrict',
        }],
      },
    })).toThrow('continuation');
  });
});

describe('Plugin Account Collection mode-derived identity declaration', () => {
  const identityCollection = {
    ...baseCollection,
    uiQueries: [],
  } as const;

  it('retains the established digest for a contract that declares no mode-derived identity', () => {
    const normalized = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.plugin',
      contribution: identityCollection,
    });
    expect(normalized.identityFields).toEqual([]);
    // Pinned from the pre-declaration normalizer. A contract that declares no
    // mode-derived identity must keep the digest its persisted rows were
    // materialized against, exactly as the empty migration chain does.
    expect(normalized.contractDigest).toBe('9wqFP4dbKjQGsJJz7aJXZVAUGYfCEbfc3hg70T8ASFA');
    expect(normalizePluginAccountCollectionContractV1({
      pluginId: 'example.plugin',
      contribution: { ...identityCollection, identityFields: [] },
    }).contractDigest).toBe(normalized.contractDigest);
  });

  it('canonicalizes a declared identity field set and binds it into the digest', () => {
    const declared = normalizePluginAccountCollectionContractV1({
      pluginId: 'example.plugin',
      contribution: { ...identityCollection, identityFields: ['status', 'id'] },
    });
    expect(declared.identityFields).toEqual(['id', 'status']);
    expect(declared.contractDigest).not.toBe(normalizePluginAccountCollectionContractV1({
      pluginId: 'example.plugin',
      contribution: identityCollection,
    }).contractDigest);
    expect(normalizePluginAccountCollectionContractV1({
      pluginId: 'example.plugin',
      contribution: { ...identityCollection, identityFields: ['id', 'status'] },
    }).contractDigest).toBe(declared.contractDigest);
  });

  it('rejects an identity field the host would never let identityTag name', () => {
    // `title` is server-readable but not indexed, so no host derivation domain
    // can ever address it.
    expect(() => PluginAccountCollectionContributionV1Schema.parse({
      ...identityCollection,
      identityFields: ['title'],
    })).toThrow('row-id field or a declared index field');
    expect(() => PluginAccountCollectionContributionV1Schema.parse({
      ...identityCollection,
      identityFields: ['id', 'id'],
    })).toThrow('Identity fields must be unique.');
    expect(PluginAccountCollectionContributionV1Schema.parse({
      ...identityCollection,
      identityFields: ['id', 'status'],
    }).identityFields).toEqual(['id', 'status']);
  });
});
