import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';
import { SessionReportsToSetRequestV1Schema, SessionReportsToSetResultV1Schema } from './sessionReportsToV1.js';

describe('Session reports-to wire contract', () => {
  it('requires an explicit expected lead and rejects unknown mutation authority', () => {
    expect(SessionReportsToSetRequestV1Schema.parse({ leadSessionId: null, expectedLeadSessionId: 'lead' }))
      .toEqual({ leadSessionId: null, expectedLeadSessionId: 'lead' });
    expect(SessionReportsToSetRequestV1Schema.safeParse({ leadSessionId: 'lead' }).success).toBe(false);
    expect(SessionReportsToSetRequestV1Schema.safeParse({ leadSessionId: 'lead', expectedLeadSessionId: null, permission: 'admin' }).success).toBe(false);
  });

  it('accepts the three typed failures and the exact attachment result', () => {
    const validate = new Ajv2020({ strict: false, validateFormats: false })
      .compile(zodSchemaToJsonSchemaObject(SessionReportsToSetResultV1Schema));
    for (const result of [
      { ok: false, error: 'reports_to_cycle' },
      { ok: false, error: 'reports_to_cas_conflict' },
      { ok: false, error: 'reports_to_forbidden', reason: 'pairwise' },
      { ok: true, sessionId: 'child', leadSessionId: 'lead', attachedAt: 42 },
      { ok: true, sessionId: 'child', leadSessionId: null, attachedAt: null },
    ]) {
      expect(SessionReportsToSetResultV1Schema.safeParse(result).success).toBe(true);
      expect(validate(result)).toBe(true);
    }
    for (const result of [
      { ok: true, sessionId: 'child', leadSessionId: 'lead', attachedAt: null },
      { ok: true, sessionId: 'child', leadSessionId: null, attachedAt: 42 },
    ]) {
      expect(SessionReportsToSetResultV1Schema.safeParse(result).success).toBe(false);
      expect(validate(result)).toBe(false);
    }
    expect(SessionReportsToSetResultV1Schema.safeParse({ ok: false, error: 'reports_to_forbidden', reason: 'owner' }).success).toBe(false);
    expect(SessionReportsToSetResultV1Schema.safeParse({ ok: true, sessionId: 'child', leadSessionId: null, attachedAt: null, permission: 'admin' }).success).toBe(false);
  });
});
