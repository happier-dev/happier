import { describe, expect, it } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1';

describe('TargetActionApprovalRequestV1Schema', () => {
  it('requires an exact qualified action subject and correlation fingerprint', () => {
    const request = { v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, generation: '7', policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run' };
    expect(TargetActionApprovalRequestV1Schema.parse(request)).toEqual(request);
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, qualifiedActionId: 'run' })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, subjectFingerprint: 'short' })).toThrow();
  });

  it('rejects non-JSON and oversized approval subjects before persistence', () => {
    const request = { v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, generation: '7', policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run' };
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, input: { value: BigInt(1) } })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, input: { value: 'x'.repeat(70_000) } })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, summary: 'x'.repeat(2_000) })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({ ...request, policyFingerprint: 'default' })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({
      ...request, status: 'canceled', decision: { kind: 'approve', decidedAtMs: 2 },
    })).toThrow();
    expect(() => TargetActionApprovalRequestV1Schema.parse({
      ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2, hidden: undefined },
    })).toThrow();
  });
});
