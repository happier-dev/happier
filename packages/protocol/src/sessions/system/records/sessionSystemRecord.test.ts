import { describe, expect, it } from 'vitest';

import * as protocol from '../../../index.js';
import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION } from '../../work/workflow/sessionWorkflowRunSnapshotV1.js';

// @ts-expect-error — predecessor lookup requests are available only under the explicit LegacyHost name.
type RetiredGenericLookupQuery = import('../../../index.js').SessionSystemRecordLookupQuery;
// @ts-expect-error — predecessor latest requests are available only under the explicit LegacyHost name.
type RetiredGenericLatestQuery = import('../../../index.js').SessionSystemRecordLatestQuery;
// @ts-expect-error — predecessor lookup responses are available only under the explicit LegacyHost name.
type RetiredGenericLookupResponse = import('../../../index.js').SessionSystemRecordLookupResponse;
// @ts-expect-error — predecessor latest responses are available only under the explicit LegacyHost name.
type RetiredGenericLatestResponse = import('../../../index.js').SessionSystemRecordLatestResponse;
void (null as unknown as RetiredGenericLookupQuery);
void (null as unknown as RetiredGenericLatestQuery);
void (null as unknown as RetiredGenericLookupResponse);
void (null as unknown as RetiredGenericLatestResponse);

type SafeParseResult = Readonly<{ success: boolean; data?: unknown }>;
type ProtocolSchemaExport = Readonly<{ safeParse: (value: unknown) => SafeParseResult; parse: (value: unknown) => unknown }>;

function protocolSchema(name: string): ProtocolSchemaExport {
  const value = (protocol as Record<string, unknown>)[name];
  expect(value).toMatchObject({ safeParse: expect.any(Function), parse: expect.any(Function) });
  return value as ProtocolSchemaExport;
}

function validSummaryShardPayload() {
  return {
    v: 1,
    seqFrom: 10,
    seqTo: 25,
    createdAtFromMs: 1000,
    createdAtToMs: 2000,
    summary: 'We discussed memory search and shard indexing.',
    keywords: ['memory', 'search'],
    entities: ['Happier'],
    decisions: ['Store memory summaries outside the transcript.'],
  };
}

function validSynopsisPayload() {
  return {
    v: 1,
    seqTo: 25,
    updatedAtMs: 3000,
    synopsis: 'The session is moving memory records out of transcript messages.',
  };
}

function validRecord() {
  return {
    id: 'sysrec_1',
    address: {
      owner: 'host',
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:10-25',
    },
    content: validSummaryShardPayload(),
    revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
    createdAt: '2026-05-19T12:00:00.000Z',
    updatedAt: '2026-05-19T12:01:00.000Z',
  };
}

function validLegacyRecord(localId: string) {
  return {
    id: 'sysrec_legacy_1',
    sessionId: 'sess_1',
    namespace: 'memory',
    kind: 'summary_shard.v1',
    localId,
    content: { t: 'encrypted', c: 'ciphertext' },
    createdAt: '2026-05-19T12:00:00.000Z',
    updatedAt: '2026-05-19T12:01:00.000Z',
  };
}

function validWorkflowRunPayload() {
  return {
    v: 1,
    projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
    runId: 'wf_demo',
    backendId: 'claude',
    title: 'Demo workflow',
    status: 'active',
    recordRevision: '1',
    updatedAt: 1000,
    totalAgents: 1,
    completedAgents: 0,
    phases: [{ id: 'phase:1', title: 'Research', order: 1, agentIds: ['a1'] }],
    agents: [{ id: 'a1', title: 'web_search', status: 'active', phaseIndex: 1, updatedAt: 1000 }],
  };
}

function validRemotePermissionSettlementPayload() {
  return {
    version: 1,
    settlementId: 'settlement-1',
    turnId: 'turn-1',
    requestId: 'request-1',
    mediatorPluginId: 'happier.channels',
    idempotencyKey: 'retry-1',
    sourceAuthority: {
      kind: 'mediatedExternal',
      mediatorPluginId: 'happier.channels',
      sourceRef: 'binding:ops',
      sourceRevisionOrEpoch: '42',
      admittedPermissionCeiling: 'default',
      remoteApprovalMaxScope: 'request',
    },
    actor: {
      kind: 'externalHuman',
      assurance: 'pluginAsserted',
      namespace: 'discord',
      principalId: 'person-1',
      assertedBy: {
        pluginId: 'happier.channels',
        contributionLocalId: 'discord',
      },
    },
    decision: 'allow',
    requestedScope: 'request',
    effect: { kind: 'allowOnce' },
    createdAtMs: 1,
  };
}

describe('session system record protocol schemas', () => {
  it('registers owner-private Permission mediation records while leaving generic record CRUD unavailable', () => {
    expect(protocol.SESSION_SYSTEM_RECORD_CATALOG).toMatchObject({
      permission: {
        kinds: {
          'remote_settlement.v1': {
            policy: {
              accountScope: 'session-owner',
              read: 'unavailable',
              write: 'unavailable',
              delete: 'unavailable',
              revision: 'opaque-row-version',
              cas: 'stored-envelope',
            },
          },
          'remote_grant.v1': {
            policy: {
              accountScope: 'session-owner',
              read: 'unavailable',
              write: 'unavailable',
              delete: 'unavailable',
              revision: 'opaque-row-version',
              cas: 'stored-envelope',
            },
          },
        },
      },
    });

    const payloadSchema = protocolSchema('SessionPermissionRemoteSettlementRecordV1Schema');
    expect(payloadSchema.safeParse(validRemotePermissionSettlementPayload()).success).toBe(true);
    expect(payloadSchema.safeParse({
      ...validRemotePermissionSettlementPayload(),
      actor: {
        ...validRemotePermissionSettlementPayload().actor,
        assertedBy: { pluginId: 'another.plugin', contributionLocalId: 'discord' },
      },
    }).success).toBe(false);
  });

  it('keeps a remote mediation row bound to its exact turn in both payload and host transport identity', () => {
    const payloadSchema = protocolSchema('SessionPermissionRemoteSettlementRecordV1Schema');
    const storedSchema = protocolSchema('SessionPermissionMediationRecordStoredSchema');
    const listResponseSchema = protocolSchema('SessionPermissionMediationRecordListResponseSchema');
    const payload = validRemotePermissionSettlementPayload();
    const { turnId: _turnId, ...withoutTurn } = payload;

    expect(payloadSchema.safeParse(payload).success).toBe(true);
    expect(payloadSchema.safeParse(withoutTurn).success).toBe(false);

    const stored = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      kind: 'remote_settlement.v1',
      content: { t: 'plain', v: payload },
      revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
    };
    expect(storedSchema.safeParse(stored).success).toBe(true);
    expect(storedSchema.safeParse({ ...stored, turnId: undefined }).success).toBe(false);

    const identity = {
      sessionId: stored.sessionId,
      turnId: stored.turnId,
      requestId: stored.requestId,
    };
    const locator = protocol.deriveSessionPermissionMediationRecordLocatorV1(identity);
    expect(locator).toMatch(/^pmr1\.[A-Za-z0-9_-]{43}$/);
    expect(protocol.deriveSessionPermissionMediationRecordLocatorV1({
      ...identity,
      turnId: 'turn-2',
    })).not.toBe(locator);
    expect(listResponseSchema.safeParse({
      records: [stored],
      nextCursor: null,
      hasNext: false,
    }).success).toBe(true);
    expect(listResponseSchema.safeParse({
      records: [{ ...stored, turnId: undefined }],
      nextCursor: null,
      hasNext: false,
    }).success).toBe(false);
    expect(protocol.SessionPermissionMediationRecordLocatorV1Schema.safeParse('pmr1.eA').success).toBe(false);
  });

  it('owns host record audience, CRUD, revision, and CAS policy in the canonical catalog', () => {
    expect(protocol.SESSION_SYSTEM_RECORD_CATALOG).toMatchObject({
      memory: {
        kinds: {
          'summary_shard.v1': {
            policy: {
              accountScope: 'actor',
              read: 'visible',
              write: 'visible',
              delete: 'visible',
              revision: 'opaque-row-version',
              cas: 'stored-envelope',
            },
          },
          'synopsis.v1': {
            policy: {
              accountScope: 'actor',
              read: 'visible',
              write: 'visible',
              delete: 'visible',
              revision: 'opaque-row-version',
              cas: 'stored-envelope',
            },
          },
        },
      },
      activity: {
        kinds: {
          'workflow_run.v1': {
            policy: {
              accountScope: 'session-owner',
              read: 'visible',
              write: 'edit',
              delete: 'edit',
              revision: 'opaque-row-version',
              cas: 'stored-envelope',
            },
          },
          'background_task.v1': {
            policy: {
              accountScope: 'session-owner',
              read: 'visible',
              write: 'edit',
              delete: 'edit',
              revision: 'opaque-row-version',
              cas: 'stored-envelope',
            },
          },
        },
      },
    });
  });

  it('keeps predecessor lookup/latest schemas behind explicit LegacyHost names', () => {
    for (const genericAlias of [
      'SessionSystemRecordLookupQuerySchema',
      'SessionSystemRecordLatestQuerySchema',
      'SessionSystemRecordLookupResponseSchema',
      'SessionSystemRecordLatestResponseSchema',
    ]) {
      expect(protocol).not.toHaveProperty(genericAlias);
    }

    expect(protocol).toHaveProperty('LegacyHostSessionSystemRecordLookupQuerySchema');
    expect(protocol).toHaveProperty('LegacyHostSessionSystemRecordLatestQuerySchema');
    expect(protocol).toHaveProperty('LegacyHostSessionSystemRecordLookupResponseSchema');
    expect(protocol).toHaveProperty('LegacyHostSessionSystemRecordLatestResponseSchema');
  });

  it('accepts qualified plugin addresses, opaque local ids, and revision-bearing author projections', () => {
    const addressSchema = protocolSchema('SessionSystemRecordAddressSchema');
    const revisionSchema = protocolSchema('SessionSystemRecordRevisionSchema');
    const recordSchema = protocolSchema('SessionSystemRecordSchema');

    const address = {
      owner: 'plugin',
      namespace: 'memory.index-v1',
      kind: 'summary.v1',
      localId: 'memory:summary_shard:v1:1-10/Ä',
    };
    expect(addressSchema.safeParse(address).success).toBe(true);
    expect(revisionSchema.safeParse('ssr1.AAAACHN5c3JlY18xAAAAAQ').success).toBe(true);
    expect(recordSchema.safeParse({ ...validRecord(), address, content: { nested: [true, null] } }).success).toBe(true);

    for (const namespace of [' Memory', 'memory/', '__proto__', 'x'.repeat(65)]) {
      expect(addressSchema.safeParse({ ...address, namespace }).success).toBe(false);
    }
    expect(addressSchema.safeParse({ ...address, localId: ' padded ' }).success).toBe(false);
    expect(addressSchema.safeParse({ ...address, localId: 'line\nfeed' }).success).toBe(false);
    expect(addressSchema.safeParse({ ...address, localId: 'é'.repeat(129) }).success).toBe(false);
  });

  it('preserves the predecessor local-id contract without loosening author-v1 addresses', () => {
    const legacyLocalIdSchema = protocolSchema('LegacyHostSessionSystemRecordLocalIdSchema');
    const legacyUpsertSchema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');
    const legacyListSchema = protocolSchema('LegacyHostSessionSystemRecordListQuerySchema');
    const legacyLookupSchema = protocolSchema('LegacyHostSessionSystemRecordLookupQuerySchema');
    const legacyRecordSchema = protocolSchema('LegacyHostSessionSystemRecordSchema');
    const legacyUpsertResponseSchema = protocolSchema('LegacyHostSessionSystemRecordUpsertResponseSchema');
    const legacyPageResponseSchema = protocolSchema('LegacyHostSessionSystemRecordPageResponseSchema');
    const legacyLookupResponseSchema = protocolSchema('LegacyHostSessionSystemRecordLookupResponseSchema');
    const legacyLatestResponseSchema = protocolSchema('LegacyHostSessionSystemRecordLatestResponseSchema');
    const authorAddressSchema = protocolSchema('SessionSystemRecordAddressSchema');
    const paddedLocalId = '  memory:synopsis:v1:padded  ';
    const trimmedLocalId = paddedLocalId.trim();
    const longLocalId = `legacy:${'x'.repeat(300)}`;

    expect(legacyLocalIdSchema.parse(paddedLocalId)).toBe(trimmedLocalId);
    expect(legacyUpsertSchema.parse({
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: paddedLocalId,
      content: { t: 'encrypted', c: 'ciphertext' },
    })).toMatchObject({ localId: trimmedLocalId });
    expect(legacyListSchema.parse({ localId: paddedLocalId })).toMatchObject({ localId: trimmedLocalId });
    expect(legacyLookupSchema.parse({ namespace: 'memory', localId: paddedLocalId }))
      .toMatchObject({ localId: trimmedLocalId });

    const legacyRecord = validLegacyRecord(longLocalId);
    expect(legacyUpsertSchema.safeParse({
      namespace: legacyRecord.namespace,
      kind: legacyRecord.kind,
      localId: longLocalId,
      content: legacyRecord.content,
    }).success).toBe(true);
    expect(legacyRecordSchema.safeParse(legacyRecord).success).toBe(true);
    expect(legacyUpsertResponseSchema.safeParse({ record: legacyRecord }).success).toBe(true);
    expect(legacyPageResponseSchema.safeParse({ records: [legacyRecord], nextCursor: null, hasNext: false }).success).toBe(true);
    expect(legacyLookupResponseSchema.safeParse({ record: legacyRecord }).success).toBe(true);
    expect(legacyLatestResponseSchema.safeParse({ record: legacyRecord }).success).toBe(true);

    const authorAddress = {
      owner: 'host',
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: trimmedLocalId,
    };
    expect(authorAddressSchema.safeParse({ ...authorAddress, localId: paddedLocalId }).success).toBe(false);
    expect(authorAddressSchema.safeParse({ ...authorAddress, localId: longLocalId }).success).toBe(false);
  });

  it('models owner-qualified list/read/delete requests without accepting an author plugin id', () => {
    const listSchema = protocolSchema('SessionSystemRecordListQuerySchema');
    const readSchema = protocolSchema('SessionSystemRecordReadRequestSchema');
    const deleteSchema = protocolSchema('SessionSystemRecordDeleteRequestSchema');
    const deleteResponseSchema = protocolSchema('SessionSystemRecordDeleteResponseSchema');
    const address = { owner: 'plugin', namespace: 'memory', kind: 'summary', localId: 'one' };

    expect(listSchema.safeParse({ owner: 'plugin', namespace: 'memory' }).success).toBe(true);
    expect(readSchema.safeParse({ address }).success).toBe(true);
    expect(deleteSchema.safeParse({ address, expectedRevision: validRecord().revision }).success).toBe(true);
    expect(deleteResponseSchema.safeParse({ ok: true }).success).toBe(true);
    expect(deleteResponseSchema.safeParse({ ok: true, extra: 'forbidden' }).success).toBe(false);
    expect(readSchema.safeParse({ address: { ...address, pluginId: 'spoofed' } }).success).toBe(false);
  });
  it('accepts encrypted and plain system-record upsert content for registered memory kinds', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');

    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:10-25',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(true);
    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: 'memory:synopsis:v1:25',
      content: { t: 'plain', v: validSynopsisPayload() },
    }).success).toBe(true);
  });

  it('rejects invalid namespace, kind, local id, and plain payload combinations', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');

    expect(schema.safeParse({
      namespace: 'search',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:10-25',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'session_summary_shard.v1',
      localId: 'memory:summary_shard:v1:10-25',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: '   ',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: 'memory:synopsis:v1:25',
      content: { t: 'plain', v: { anything: true } },
    }).success).toBe(false);
  });

  it('validates memory payloads and route response shapes', () => {
    const genericPayloadSchema = protocolSchema('SessionSystemRecordPayloadSchema');
    const payloadSchema = protocolSchema('MemorySessionSystemRecordPayloadSchema');
    const pageSchema = protocolSchema('SessionSystemRecordPageResponseSchema');
    const latestSchema = protocolSchema('LegacyHostSessionSystemRecordLatestResponseSchema');
    const lookupSchema = protocolSchema('LegacyHostSessionSystemRecordLookupResponseSchema');

    expect(genericPayloadSchema.safeParse(validSummaryShardPayload()).success).toBe(true);
    expect(genericPayloadSchema.safeParse({
      kind: 'summary_shard.v1',
      payload: validSummaryShardPayload(),
    }).success).toBe(false);
    expect(payloadSchema.safeParse({
      kind: 'summary_shard.v1',
      payload: validSummaryShardPayload(),
    }).success).toBe(true);
    expect(payloadSchema.safeParse({
      kind: 'synopsis.v1',
      payload: validSynopsisPayload(),
    }).success).toBe(true);
    expect(pageSchema.safeParse({
      records: [validRecord()],
      nextCursor: 'cursor_2',
      hasNext: true,
    }).success).toBe(true);
    expect(latestSchema.safeParse({ record: null }).success).toBe(true);
    expect(lookupSchema.safeParse({ record: null }).success).toBe(true);
  });
});

describe('activity/workflow_run.v1 system record', () => {
  it('accepts encrypted upsert content for the registered activity workflow kind', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf_demo',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(true);
  });

  it('accepts plain upsert content for the registered activity workflow kind', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf_demo',
      content: { t: 'plain', v: validWorkflowRunPayload() },
    }).success).toBe(true);
  });

  it('rejects plain activity content that does not match the workflow_run.v1 payload', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf_demo',
      content: { t: 'plain', v: { ...validWorkflowRunPayload(), status: 'running' } },
    }).success).toBe(false);
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf_demo',
      content: { t: 'plain', v: { anything: true } },
    }).success).toBe(false);
  });

  it('rejects cross-namespace/kind pairs that are not registered together', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');
    // workflow kind under the memory namespace is not a registered pair.
    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'workflow_run.v1',
      localId: 'memory:workflow_run:v1:wf_demo',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
    // memory kind under the activity namespace is not a registered pair.
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'synopsis.v1',
      localId: 'activity:synopsis:v1:25',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
  });

  it('exposes the activity namespace and workflow kind through the catalog, and builds the canonical local id', () => {
    const isRegistered = (protocol as Record<string, unknown>).isRegisteredSessionSystemRecordKind as (
      namespace: string,
      kind: string,
    ) => boolean;
    expect(isRegistered('activity', 'workflow_run.v1')).toBe(true);
    expect(isRegistered('memory', 'workflow_run.v1')).toBe(false);
    expect(isRegistered('activity', 'synopsis.v1')).toBe(false);

    const buildLocalId = (protocol as Record<string, unknown>).buildWorkflowRunSystemRecordLocalId as (
      params: { runId: string },
    ) => string;
    expect(buildLocalId({ runId: 'wf_demo' })).toBe('activity:workflow_run:v1:wf_demo');
  });

  it('round-trips memory and activity records through the same generic raw payload schema', () => {
    const genericPayloadSchema = protocolSchema('SessionSystemRecordPayloadSchema');
    expect(genericPayloadSchema.safeParse(validSummaryShardPayload()).success).toBe(true);
    expect(genericPayloadSchema.safeParse(validWorkflowRunPayload()).success).toBe(true);
  });
});

describe('activity/background_task.v1 system record', () => {
  function validBackgroundTaskPayload() {
    return {
      v: 1,
      taskId: 'task_42',
      kind: 'command',
      status: 'succeeded',
      label: 'yarn test:unit',
      startedAt: 1000,
      endedAt: 2000,
      updatedAt: 2000,
    };
  }

  it('registers the kind inside the existing activity namespace', () => {
    const isRegistered = (protocol as Record<string, unknown>).isRegisteredSessionSystemRecordKind as (
      namespace: string,
      kind: string,
    ) => boolean;
    expect(isRegistered('activity', 'background_task.v1')).toBe(true);
    expect(isRegistered('memory', 'background_task.v1')).toBe(false);
  });

  it('addresses one task to one record through the canonical local id, and refuses an unidentifiable task', () => {
    const buildLocalId = (protocol as Record<string, unknown>).buildBackgroundTaskSystemRecordLocalId as (
      params: { taskId: string },
    ) => string;
    expect(buildLocalId({ taskId: 'task_42' })).toBe('activity:background_task:v1:task_42');
    // An empty task id would address every unidentifiable task to one shared record, each
    // overwriting the last with nothing failing loudly.
    expect(() => buildLocalId({ taskId: '   ' })).toThrow();
  });

  it('accepts a redacted payload and rejects a label longer than redaction can emit', () => {
    const schema = protocolSchema('LegacyHostSessionSystemRecordUpsertRequestSchema');
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_42',
      content: { t: 'plain', v: validBackgroundTaskPayload() },
    }).success).toBe(true);
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_42',
      content: { t: 'plain', v: { ...validBackgroundTaskPayload(), label: 'x'.repeat(121) } },
    }).success).toBe(false);
  });

  it('refuses a provider status word and an unclassified row', () => {
    const schema = protocolSchema('SessionBackgroundTaskRecordV1Schema');
    // `completed`/`killed` are provider words that map at the CLI adapter; they never land here.
    expect(schema.safeParse({ ...validBackgroundTaskPayload(), status: 'completed' }).success).toBe(false);
    const { kind: _kind, ...withoutKind } = validBackgroundTaskPayload();
    expect(schema.safeParse(withoutKind).success).toBe(false);
  });

  it('drops fields the contract does not name instead of forwarding them', () => {
    const schema = protocolSchema('SessionBackgroundTaskRecordV1Schema');
    const parsed = schema.parse({ ...validBackgroundTaskPayload(), command: 'rm -rf /Users/alice/secret' });
    expect(parsed).not.toHaveProperty('command');
  });
});
