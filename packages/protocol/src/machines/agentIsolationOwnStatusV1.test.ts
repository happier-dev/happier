import { describe, expect, it } from 'vitest';
import { listActionSpecs } from '../actions/actionSpecs.js';
import { MachineAgentIsolationOwnStatusV1Schema } from './agentIsolationV1.js';

describe('own Machine execution protection Action contract', () => {
  it('accepts an omitted directory projection and the separated member own directories', () => {
    const status = { protection: 'member_separated', status: { kind: 'effective', platform: 'linux' } };
    expect(MachineAgentIsolationOwnStatusV1Schema.parse(status)).toEqual(status);
    const projected = { ...status, directories: { home: '/member/home', workspace: '/member/workspace' } };
    expect(MachineAgentIsolationOwnStatusV1Schema.parse(projected)).toEqual(projected);
    expect(MachineAgentIsolationOwnStatusV1Schema.safeParse({ ...status, directories: { home: '' } }).success).toBe(false);
  });
  it('accepts only the Machine target and keeps false separation claims out of the strict response', () => {
    const spec = listActionSpecs().find(candidate => String(candidate.id) === 'machines.agentIsolation.status');
    expect(spec, 'Own protection must have a registered public Machine Action').toBeDefined();
    if (!spec) throw new Error('Own protection Action is not registered');
    expect(spec.executionPlacement).toBe('machine');
    expect(spec.safety).toBe('safe');
    expect(spec.inputSchema.safeParse({ machineId: 'machine' }).success).toBe(true);
    for (const identity of [{ uid: 123 }, { gid: 123 }, { username: 'other' }, { home: '/other' }, { owner: true }, { executionKind: 'person_break_glass' }]) {
      expect(spec.inputSchema.safeParse({ machineId: 'machine', ...identity }).success).toBe(false);
    }
    expect(spec.outputSchema.safeParse({ protection: 'shared_user', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ protection: 'member_separated', status: { kind: 'effective', platform: 'linux' } }).success).toBe(true);
    for (const wrong of [
      { protection: 'member_separated', status: { kind: 'disabled' } },
      { protection: 'member_separated', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } },
      { protection: 'unavailable', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } },
      { protection: 'setup_pending', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } },
      { protection: 'shared_user', status: { kind: 'unavailable', code: 'agent_user_missing' } },
    ]) expect(spec.outputSchema.safeParse(wrong).success).toBe(false);
  });
});
