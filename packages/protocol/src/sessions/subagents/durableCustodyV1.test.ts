import { describe, expect, it } from 'vitest';

import {
  createSessionSubagentCustodyPlainContentFingerprintV1,
  createSessionSubagentCustodyKeyV1,
  serializeSessionSubagentCustodyDetailV1,
  serializeSessionSubagentCustodyEncryptedFingerprintInputV1,
  SessionSubagentCustodyListQueryV1Schema,
  SessionSubagentCustodyMutationRequestV1Schema,
  SessionSubagentCustodyRecordV1Schema,
  SessionSubagentCustodyRetirementRequestV1Schema,
  SessionSubagentCustodyRetirementResponseV1Schema,
  SessionSubagentCustodyScopeV1Schema,
  isSessionSubagentStatusTransitionAllowed,
} from './durableCustodyV1.js';

describe('durable subagent custody v1 contract', () => {
  const scope = {
    pluginId: 'acme.agent',
    contributionId: 'assistant',
    immutableGenerationId: 'generation-content-digest-1',
  } as const;
  const custodyKey = createSessionSubagentCustodyKeyV1({ ...scope, sessionId: 'session-a' });
  it('rejects terminal regressions while allowing idempotent terminal updates', () => {
    expect(isSessionSubagentStatusTransitionAllowed('completed', 'running')).toBe(false);
    expect(isSessionSubagentStatusTransitionAllowed('failed', 'completed')).toBe(false);
    expect(isSessionSubagentStatusTransitionAllowed('aborted', 'pending')).toBe(false);
    expect(isSessionSubagentStatusTransitionAllowed('completed', 'completed')).toBe(true);
    expect(isSessionSubagentStatusTransitionAllowed('running', 'completed')).toBe(true);
  });

  it('requires an explicit expected revision and stored-content envelope', () => {
    const missingCas = SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      operationId: 'operation-1',
      scope,
      custodyKey,
      subagentId: 'subagent-1',
      status: 'running',
      content: { t: 'encrypted', c: 'Y2lwaGVydGV4dA==' },
    });
    const bareDetail = SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      operationId: 'operation-1',
      scope,
      custodyKey,
      subagentId: 'subagent-1',
      expectedRevision: null,
      status: 'running',
      content: { detail: 'plaintext' },
    });
    expect(missingCas.success).toBe(false);
    expect(bareDetail.success).toBe(false);
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      operationId: 'operation-1',
      scope,
      custodyKey,
      subagentId: 'subagent-1',
      expectedRevision: null,
      status: 'running',
      content: 'legacy-bare-ciphertext',
    }).success).toBe(false);
    for (const content of [
      { ciphertext: 'legacy' },
      { t: 'encrypted', c: 'Y2lwaGVydGV4dA==', v: 'mixed' },
      { t: 'plain', v: 1n },
    ]) {
      expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
        operationId: 'operation-1', scope, custodyKey, subagentId: 'subagent-1',
        groupId: null, expectedRevision: null, status: 'running',
        contentFingerprint: `hmac-sha256:${'a'.repeat(64)}`,
        content,
      }).success).toBe(false);
    }
    const accessorEnvelope = Object.defineProperty({}, 't', { enumerable: true, get: () => 'encrypted' });
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      operationId: 'operation-1', scope, custodyKey, subagentId: 'subagent-1',
      groupId: null, expectedRevision: null, status: 'running',
      contentFingerprint: `hmac-sha256:${'a'.repeat(64)}`,
      content: accessorEnvelope,
    }).success).toBe(false);
  });

  it('bounds encrypted record content and accepts only canonical base64 ciphertext', () => {
    const base = {
      operationId: 'operation-1', scope, custodyKey, subagentId: 'subagent-1', groupId: null,
      expectedRevision: null, status: 'running' as const,
      contentFingerprint: `hmac-sha256:${'a'.repeat(64)}`,
    };
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      content: { t: 'encrypted', c: 'bm90IGNhbm9uaWNhbA==' },
    }).success).toBe(true);
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      content: { t: 'encrypted', c: 'not base64!' },
    }).success).toBe(false);
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      content: { t: 'encrypted', c: 'A'.repeat(2_000_000) },
    }).success).toBe(false);
  });

  it('requires a strict content fingerprint and canonicalizes semantic detail independently of key order', () => {
    const left = serializeSessionSubagentCustodyDetailV1({ z: 1, nested: { b: true, a: null } });
    const right = serializeSessionSubagentCustodyDetailV1({ nested: { a: null, b: true }, z: 1 });
    expect(left).toBe(right);
    expect(left).toMatch(/^happier:session-subagent-custody-detail:v1\u0000/u);
    expect(createSessionSubagentCustodyPlainContentFingerprintV1({ z: 1, nested: { b: true, a: null } }))
      .toBe(createSessionSubagentCustodyPlainContentFingerprintV1({ nested: { a: null, b: true }, z: 1 }));

    const base = {
      operationId: 'operation-1', scope, custodyKey, subagentId: 'subagent-1', groupId: null,
      expectedRevision: null, status: 'running' as const, content: { t: 'plain' as const, v: null },
    };
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse(base).success).toBe(false);
    for (const contentFingerprint of [
      'sha256:ABC',
      `sha256:${'a'.repeat(63)}`,
      `hmac-sha256:${'g'.repeat(64)}`,
      `other:${'a'.repeat(64)}`,
    ]) {
      expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({ ...base, contentFingerprint }).success).toBe(false);
    }
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      contentFingerprint: createSessionSubagentCustodyPlainContentFingerprintV1(null),
    }).success).toBe(true);
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      contentFingerprint: `hmac-sha256:${'a'.repeat(64)}`,
    }).success).toBe(false);
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      content: { t: 'encrypted', c: 'Y2lwaGVydGV4dA==' },
      contentFingerprint: `hmac-sha256:${'a'.repeat(64)}`,
    }).success).toBe(true);
    expect(SessionSubagentCustodyMutationRequestV1Schema.safeParse({
      ...base,
      content: { t: 'encrypted', c: 'Y2lwaGVydGV4dA==' },
      contentFingerprint: createSessionSubagentCustodyPlainContentFingerprintV1(null),
    }).success).toBe(false);
  });

  it('canonicalizes every strict JSON shape within bounds without invoking hostile values', () => {
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => { throw new Error('must not execute'); },
    });
    class HostObject { value = 1; }

    expect(serializeSessionSubagentCustodyDetailV1([
      null,
      true,
      -0,
      { 'é': 'composed', 'e\u0301': 'decomposed', nested: ['value'] },
    ])).toContain('"nested":["value"]');
    expect(serializeSessionSubagentCustodyDetailV1(-0)).toBe(serializeSessionSubagentCustodyDetailV1(0));
    expect(createSessionSubagentCustodyPlainContentFingerprintV1({ text: 'é' }))
      .not.toBe(createSessionSubagentCustodyPlainContentFingerprintV1({ text: 'e\u0301' }));
    expect(() => serializeSessionSubagentCustodyDetailV1(accessor as never)).toThrow();
    expect(() => serializeSessionSubagentCustodyDetailV1(new HostObject() as never)).toThrow();

    let overDepth: unknown = null;
    for (let depth = 0; depth < 26; depth += 1) overDepth = [overDepth];
    expect(() => serializeSessionSubagentCustodyDetailV1(overDepth as never)).toThrow();
    expect(() => serializeSessionSubagentCustodyDetailV1(
      Array.from({ length: 4_096 }, () => 'x'.repeat(255)),
    )).toThrow();
  });

  it('binds encrypted fingerprint input to the exact session and custody scope', () => {
    const detail = { nested: [null, { b: 2, a: 1 }] };
    const base = serializeSessionSubagentCustodyEncryptedFingerprintInputV1({
      sessionId: 'session-a', custodyKey, detail,
    });
    expect(base).toBe(serializeSessionSubagentCustodyEncryptedFingerprintInputV1({
      sessionId: 'session-a', custodyKey, detail: { nested: [null, { a: 1, b: 2 }] },
    }));
    expect(base).not.toBe(serializeSessionSubagentCustodyEncryptedFingerprintInputV1({
      sessionId: 'session-b', custodyKey, detail,
    }));
    expect(base).not.toBe(serializeSessionSubagentCustodyEncryptedFingerprintInputV1({
      sessionId: 'session-a', custodyKey: `sha256:${'b'.repeat(64)}`, detail,
    }));
  });

  it('uses an immutable all-record list contract within the 256-record custody bound', () => {
    expect(SessionSubagentCustodyListQueryV1Schema.parse({ ...scope, custodyKey })).toEqual({ ...scope, custodyKey });
    expect(SessionSubagentCustodyListQueryV1Schema.safeParse({ ...scope, custodyKey, cursor: 'mutable-time-cursor' }).success).toBe(false);
  });

  it('derives the custody key from the exact qualified generation and session scope', () => {
    expect(custodyKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(custodyKey).not.toBe(createSessionSubagentCustodyKeyV1({ ...scope, sessionId: 'session-b' }));
    expect(custodyKey).not.toBe(createSessionSubagentCustodyKeyV1({ ...scope, contributionId: 'reviewer', sessionId: 'session-a' }));
    expect(custodyKey).not.toBe(createSessionSubagentCustodyKeyV1({ ...scope, immutableGenerationId: 'generation-content-digest-2', sessionId: 'session-a' }));
    const composedGenerationId = 'generation-\u00e9';
    const decomposedGenerationId = 'generation-e\u0301';
    expect(SessionSubagentCustodyScopeV1Schema.parse({ ...scope, immutableGenerationId: composedGenerationId }).immutableGenerationId)
      .toBe(composedGenerationId);
    expect(SessionSubagentCustodyScopeV1Schema.parse({ ...scope, immutableGenerationId: decomposedGenerationId }).immutableGenerationId)
      .toBe(decomposedGenerationId);
    expect(createSessionSubagentCustodyKeyV1({ ...scope, immutableGenerationId: composedGenerationId, sessionId: 'session-a' }))
      .not.toBe(createSessionSubagentCustodyKeyV1({ ...scope, immutableGenerationId: decomposedGenerationId, sessionId: 'session-a' }));
  });

  it('defines one strict idempotent actor-wide qualified-generation retirement contract', () => {
    const retirement = { pluginId: scope.pluginId, immutableGenerationId: scope.immutableGenerationId };
    expect(SessionSubagentCustodyRetirementRequestV1Schema.parse(retirement)).toEqual(retirement);
    expect(SessionSubagentCustodyRetirementRequestV1Schema.safeParse({ ...retirement, contributionId: scope.contributionId }).success).toBe(false);
    expect(SessionSubagentCustodyRetirementRequestV1Schema.safeParse({ pluginId: scope.pluginId, immutableGenerationId: '' }).success).toBe(false);
    expect(SessionSubagentCustodyRetirementResponseV1Schema.parse({ retired: true })).toEqual({ retired: true });
    expect(SessionSubagentCustodyRetirementResponseV1Schema.safeParse({ retired: true, deletedRecords: 1 }).success).toBe(false);
  });

  it('preserves exact opaque identifiers without trimming and permits the SDK empty group id', () => {
    const parsed = SessionSubagentCustodyMutationRequestV1Schema.parse({
      operationId: ' operation ', scope, custodyKey, subagentId: ' qualified/id ', groupId: '',
      expectedRevision: null, status: 'running', contentFingerprint: `hmac-sha256:${'a'.repeat(64)}`,
      content: { t: 'encrypted', c: 'Y2lwaGVydGV4dA==' },
    });
    expect(parsed.operationId).toBe(' operation ');
    expect(parsed.subagentId).toBe(' qualified/id ');
    expect(parsed.groupId).toBe('');
  });

  it('keeps internal scope and lifecycle detail out of public summaries', () => {
    expect(SessionSubagentCustodyRecordV1Schema.safeParse({
      subagentId: 'subagent-1', groupId: null, status: 'running', revision: 0, updatedAt: 1,
      custodyKey, createdAt: 1, terminalAt: null, content: { t: 'encrypted', c: 'ciphertext' },
    }).success).toBe(false);
  });
});
