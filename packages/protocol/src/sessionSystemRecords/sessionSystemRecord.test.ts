import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';
import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION } from '../sessionWorkflowActivity/sessionWorkflowRunSnapshotV1.js';

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
    sessionId: 'sess_1',
    namespace: 'memory',
    kind: 'summary_shard.v1',
    localId: 'memory:summary_shard:v1:10-25',
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

function validBackgroundTaskPayload() {
  return {
    v: 1,
    taskId: 'task_1',
    kind: 'command',
    status: 'running',
    label: 'grep -rn "thing" ~/repo',
    updatedAt: 1000,
  };
}

describe('session system record protocol schemas', () => {
  it('accepts encrypted system-record upsert content for registered memory kinds', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

    const parsed = schema.safeParse({
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:10-25',
      content: { t: 'encrypted', c: 'ciphertext' },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts plain system-record upsert content for registered memory kinds', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

    const parsed = schema.safeParse({
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: 'memory:synopsis:v1:25',
      content: { t: 'plain', v: validSynopsisPayload() },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects plain system-record upsert content that does not match the registered memory payload', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'synopsis.v1',
      localId: 'memory:synopsis:v1:25',
      content: { t: 'plain', v: { anything: true } },
    }).success).toBe(false);
    expect(schema.safeParse({
      namespace: 'memory',
      kind: 'summary_shard.v1',
      localId: 'memory:summary_shard:v1:10-25',
      content: {
        t: 'plain',
        v: {
          ...validSummaryShardPayload(),
          seqFrom: 30,
        },
      },
    }).success).toBe(false);
  });

  it('accepts encrypted system-record upsert content for the registered activity workflow kind', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

    const parsed = schema.safeParse({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf_demo',
      content: { t: 'encrypted', c: 'ciphertext' },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts plain system-record upsert content for the registered activity workflow kind', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

    const parsed = schema.safeParse({
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf_demo',
      content: { t: 'plain', v: validWorkflowRunPayload() },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects plain activity content that does not match the workflow_run.v1 payload', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

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
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

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

  it('exposes the activity namespace and workflow kind through the catalog', () => {
    const isRegistered = (protocol as Record<string, unknown>).isRegisteredSessionSystemRecordKind as (
      namespace: string,
      kind: string,
    ) => boolean;
    expect(isRegistered('activity', 'workflow_run.v1')).toBe(true);
    expect(isRegistered('memory', 'workflow_run.v1')).toBe(false);
    expect(isRegistered('activity', 'synopsis.v1')).toBe(false);
  });

  it('registers activity/background_task.v1 so the record can actually be written', () => {
    // A kind that is declared but unregistered parses everywhere and is rejected at the one place
    // that matters — the upsert route — so registration is the reachability check for the kind.
    const isRegistered = (protocol as Record<string, unknown>).isRegisteredSessionSystemRecordKind as (
      namespace: string,
      kind: string,
    ) => boolean;
    expect(isRegistered('activity', 'background_task.v1')).toBe(true);

    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_1',
      content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(true);
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_1',
      content: { t: 'plain', v: validBackgroundTaskPayload() },
    }).success).toBe(true);
  });

  it('rejects plain activity content that does not match the background_task.v1 payload', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

    // A provider terminal word instead of the protocol status vocabulary.
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_1',
      content: { t: 'plain', v: { ...validBackgroundTaskPayload(), status: 'completed' } },
    }).success).toBe(false);
    // A workflow snapshot filed under the background-task kind.
    expect(schema.safeParse({
      namespace: 'activity',
      kind: 'background_task.v1',
      localId: 'activity:background_task:v1:task_1',
      content: { t: 'plain', v: validWorkflowRunPayload() },
    }).success).toBe(false);
  });

  it('addresses one background task at one stable local id', () => {
    const build = (protocol as Record<string, unknown>).buildBackgroundTaskSystemRecordLocalId as (
      params: { taskId: string },
    ) => string;

    expect(build({ taskId: 'task_1' })).toBe('activity:background_task:v1:task_1');
    expect(build({ taskId: '  task_1  ' })).toBe(build({ taskId: 'task_1' }));
    // An empty id would collide every unaddressable task onto one record; task ids arrive from
    // provider events, so this is a reachable input rather than a programmer-only mistake.
    expect(() => build({ taskId: '   ' })).toThrow();
  });

  it('rejects unregistered namespaces, kinds, and blank local ids', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

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
  });

  it('validates memory system-record payload contracts by kind', () => {
    const schema = protocolSchema('MemorySessionSystemRecordPayloadSchema');

    expect(schema.safeParse({
      kind: 'summary_shard.v1',
      payload: validSummaryShardPayload(),
    }).success).toBe(true);
    expect(schema.safeParse({
      kind: 'synopsis.v1',
      payload: validSynopsisPayload(),
    }).success).toBe(true);
    expect(schema.safeParse({
      kind: 'summary_shard.v1',
      payload: {
        ...validSummaryShardPayload(),
        seqFrom: 30,
      },
    }).success).toBe(false);
  });

  it('exports the generic system-record payload schema as raw plain-content payload values', () => {
    const schema = protocolSchema('SessionSystemRecordPayloadSchema');

    expect(schema.safeParse(validSummaryShardPayload()).success).toBe(true);
    expect(schema.safeParse(validSynopsisPayload()).success).toBe(true);
    expect(schema.safeParse({
      kind: 'synopsis.v1',
      payload: validSynopsisPayload(),
    }).success).toBe(false);
  });

  it('supports paginated list responses', () => {
    const schema = protocolSchema('SessionSystemRecordPageResponseSchema');

    const parsed = schema.safeParse({
      records: [validRecord()],
      nextCursor: 'cursor_2',
      hasNext: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('supports latest-by-namespace-kind query and nullable response shapes', () => {
    const querySchema = protocolSchema('SessionSystemRecordLatestQuerySchema');
    const responseSchema = protocolSchema('SessionSystemRecordLatestResponseSchema');

    expect(querySchema.safeParse({
      namespace: 'memory',
      kind: 'synopsis.v1',
    }).success).toBe(true);
    expect(responseSchema.safeParse({
      record: {
        ...validRecord(),
        kind: 'synopsis.v1',
        localId: 'memory:synopsis:v1:25',
        content: { t: 'plain', v: validSynopsisPayload() },
      },
    }).success).toBe(true);
    expect(responseSchema.safeParse({ record: null }).success).toBe(true);
  });
});
