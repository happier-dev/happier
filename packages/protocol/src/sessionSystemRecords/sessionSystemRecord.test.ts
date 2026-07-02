import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

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

describe('session system record protocol schemas', () => {
  it('accepts encrypted and plain system-record upsert content for registered memory kinds', () => {
    const schema = protocolSchema('SessionSystemRecordUpsertRequestSchema');

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
    const latestSchema = protocolSchema('SessionSystemRecordLatestResponseSchema');
    const lookupSchema = protocolSchema('SessionSystemRecordLookupResponseSchema');

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
