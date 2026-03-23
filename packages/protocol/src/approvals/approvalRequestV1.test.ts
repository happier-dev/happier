import { describe, expect, it } from 'vitest';

import { ApprovalRequestV1Schema } from './approvalRequestV1.js';

describe('ApprovalRequestV1Schema', () => {
  it('parses a minimal open approval request', () => {
    const parsed = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
    });

    expect(parsed.status).toBe('open');
    expect(parsed.actionId).toBe('review.start');
  });

  it('rejects open requests that already include a decision or execution payload', () => {
    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      decision: { kind: 'approve', decidedAtMs: 2 },
    })).toThrow(/decision/i);

    expect(() => ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'system' },
      actionId: 'review.start',
      actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
      summary: 'Run review',
      execution: { executedAtMs: 3, ok: true },
    })).toThrow(/execution/i);
  });

  it('requires a decision for approved, rejected, executed, and failed requests', () => {
    for (const status of ['approved', 'rejected', 'executed', 'failed'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
      })).toThrow(/decision/i);
    }
  });

  it('requires execution metadata for executed and failed requests', () => {
    for (const status of ['executed', 'failed'] as const) {
      expect(() => ApprovalRequestV1Schema.parse({
        v: 1,
        status,
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        actionId: 'review.start',
        actionArgs: { sessionId: 's1', engineIds: ['x'], instructions: 'y' },
        summary: 'Run review',
        decision: { kind: 'approve', decidedAtMs: 2 },
      })).toThrow(/execution/i);
    }
  });
});
