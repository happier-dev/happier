import { describe, expect, it } from 'vitest';
import { USAGE_ACTION_SPECS } from '../actions/specs/usage.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { UiActionDispatchRequestV1Schema } from '../actions/clientDispatchV1.js';

describe('explicit Usage history Action admission', () => {
  it('admits one Account write with read, status and cancellation, without caller-supplied authority', () => {
    const spec = USAGE_ACTION_SPECS.find(candidate => String(candidate.id) === 'usage.history.read');
    expect(spec, 'the explicit history Action must be registered').toBeDefined();
    expect(spec).toMatchObject({ sideEffectClass: 'write', requiredAuthority: 'account_automation',
      executionPlacement: 'client', surfaces: { ui: true, agent: true, mcp: true, cli: true } });
    const query = normalizeUsageQuery({ period: { relative: '90days' } });
    for (const operation of ['read', 'status', 'cancel']) {
      expect(spec!.inputSchema.safeParse({ query, operation }).success).toBe(true);
    }
    expect(spec!.inputSchema.parse({ query })).toEqual({ query, operation: 'read' });
    for (const extra of [{ accountId: 'other-account' }, { sessionIds: ['unadmitted'] }, { signal: {} }]) {
      expect(spec!.inputSchema.safeParse({ query, ...extra }).success).toBe(false);
    }
    expect(spec!.inputSchema.safeParse({ query, operation: 'restart' }).success).toBe(false);
  });

  it('carries truthful partial and cancelled progress without accepting content in the progress envelope', () => {
    const spec = USAGE_ACTION_SPECS.find(candidate => String(candidate.id) === 'usage.history.read');
    expect(spec, 'the explicit history Action must expose its result contract').toBeDefined();
    const progress = { selected: 7, notRead: 3, completed: 3, failed: 1 };
    for (const status of ['idle', 'reading', 'complete', 'cancelled', 'partial']) {
      expect(spec!.outputSchema.safeParse({ status, progress }).success).toBe(true);
    }
    expect(spec!.outputSchema.safeParse({ status: 'partial', progress, errorCode: 'session_content_locked' }).success).toBe(true);
    expect(spec!.outputSchema.safeParse({ status: 'reading', progress: { ...progress, completed: -1 } }).success).toBe(false);
    expect(spec!.outputSchema.safeParse({ status: 'reading', progress: { ...progress, transcript: 'private content' } }).success).toBe(false);
    expect(spec!.outputSchema.safeParse({ status: 'reading', progress, token: 'private token' }).success).toBe(false);
  });

  it('admits an agent history request through the existing client dispatch boundary', () => {
    expect(UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId: 'usage.history.read',
      input: { query: normalizeUsageQuery({ period: { relative: '90days' } }), operation: 'read' },
      context: { surface: 'agent', authority: 'account_automation' },
    }).success).toBe(true);
  });
});
