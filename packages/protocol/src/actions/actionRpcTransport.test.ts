import { describe, expect, it } from 'vitest';

import { createTargetedActionRpcRequestV1, TargetedActionRpcRequestV1Schema } from './actionRpcTransport.js';

describe('targeted Action RPC request', () => {
  it('keeps one strict Machine/project target outside opaque semantic input', () => {
    const input = { runId: 'run-1' };
    expect(TargetedActionRpcRequestV1Schema.parse({
      v: 1,
      kind: 'targeted_action_rpc',
      input,
      target: {
        kind: 'machine',
        machineId: 'machine-1',
        project: { machineId: 'machine-1', directory: '/repo' },
      },
    })).toEqual({
      v: 1,
      kind: 'targeted_action_rpc',
      input,
      target: {
        kind: 'machine',
        machineId: 'machine-1',
        project: { machineId: 'machine-1', directory: '/repo' },
      },
    });
    expect(TargetedActionRpcRequestV1Schema.safeParse({
      v: 1,
      kind: 'targeted_action_rpc',
      input,
      target: {
        kind: 'machine',
        machineId: 'machine-1',
        project: { machineId: 'machine-2', directory: '/repo' },
      },
    }).success).toBe(false);
    expect(TargetedActionRpcRequestV1Schema.safeParse({
      v: 1,
      kind: 'targeted_action_rpc',
      target: { kind: 'machine', machineId: 'machine-1' },
    }).success).toBe(false);
    expect(TargetedActionRpcRequestV1Schema.safeParse({
      v: 1,
      kind: 'targeted_action_rpc',
      input,
      target: { kind: 'machine', machineId: 'machine-1' },
      authority: 'admin',
    }).success).toBe(false);
  });

  it('carries the invoking session as transport context, never inside semantic input', () => {
    const input = { runId: 'run-1' };
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    expect(createTargetedActionRpcRequestV1(input, target, { defaultSessionId: 'session-1' }))
      .toEqual({ v: 1, kind: 'targeted_action_rpc', input, target, defaultSessionId: 'session-1' });
    expect(createTargetedActionRpcRequestV1(input, target)).not.toHaveProperty('defaultSessionId');
    expect(TargetedActionRpcRequestV1Schema.safeParse({ v: 1, kind: 'targeted_action_rpc', input, target, defaultSessionId: ' ' }).success)
      .toBe(false);
  });

  it('carries only the host-stamped plugin identity for a Session target', () => {
    const request = {
      v: 1,
      kind: 'targeted_action_rpc',
      input: { sessionId: 'session-1', sourceRef: 'binding:ops', sourceRevisionOrEpoch: '1' },
      target: { kind: 'session', sessionId: 'session-1' },
      pluginCaller: { pluginId: 'happier.channels', contributionLocalId: 'outward-supervisor' },
    };
    expect(TargetedActionRpcRequestV1Schema.parse(request)).toEqual(request);
    expect(TargetedActionRpcRequestV1Schema.safeParse({
      ...request, pluginCaller: { ...request.pluginCaller, authority: 'present_user' },
    }).success).toBe(false);
    expect(TargetedActionRpcRequestV1Schema.safeParse({
      ...request, target: { kind: 'machine', machineId: 'machine-1' },
    }).success).toBe(false);
  });
});
