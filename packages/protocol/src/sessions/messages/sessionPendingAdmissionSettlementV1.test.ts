import { describe, expect, it } from 'vitest';

import {
  SessionPendingAdmissionSettlementRequestV1Schema,
  SessionPendingAdmissionSettlementResponseV1Schema,
} from './sessionPendingAdmissionSettlementV1.js';

const base = {
  v: 1 as const,
  sessionId: 'session-target',
  localId: 'plugin-input-v1:abc',
};

describe('Session Pending admission settlement V1', () => {
  it('accepts one strict admitted final envelope plus server-validation facts', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.parse({
      ...base,
      decision: {
        kind: 'admit',
        finalContent: {
          t: 'plain',
          v: { role: 'user', meta: { happierInputAuthorityV1: { v: 1 } } },
        },
        validation: {
          sourceSession: { sourceSessionId: 'session-source', sourceTurnId: 'turn-source', via: 'action' },
          automation: { automationId: 'automation-1', runId: 'run-1' },
        },
      },
    })).toMatchObject({ decision: { kind: 'admit' } });
  });

  it('requires the exact source Session transport when settlement carries source correlation', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({
      ...base,
      decision: {
        kind: 'reject',
        code: 'session_input_untrusted_assertion',
        validation: {
          sourceSession: { sourceSessionId: 'session-source', sourceTurnId: 'turn-source' },
        },
      },
    }).success).toBe(false);
  });

  it('accepts only typed durable rejection without final content', () => {
    expect(SessionPendingAdmissionSettlementRequestV1Schema.parse({
      ...base,
      decision: {
        kind: 'reject',
        code: 'session_input_permission_ceiling_rejected',
      },
    })).toEqual({
      ...base,
      decision: {
        kind: 'reject',
        code: 'session_input_permission_ceiling_rejected',
      },
    });
    expect(SessionPendingAdmissionSettlementRequestV1Schema.safeParse({
      ...base,
      decision: {
        kind: 'reject',
        code: 'free-form',
        finalContent: { t: 'plain', v: {} },
      },
    }).success).toBe(false);
  });

  it('returns only terminal admission truth', () => {
    expect(SessionPendingAdmissionSettlementResponseV1Schema.parse({
      v: 1,
      result: { status: 'accepted', localId: base.localId },
    })).toEqual({
      v: 1,
      result: { status: 'accepted', localId: base.localId },
    });
  });
});
