import { describe, expect, it } from 'vitest';
import { MachineAddSshRespondInputSchema, MachineAddSshStartInputSchema } from './machineConnection.js';

const identity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
  adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } as const;

describe('standalone SSH enrollment admission', () => {
  it.each([{ serverId: 'home', host: 'server', authMode: 'keyfile' },
    { serverId: 'home', savedHostId: 'saved-host', expectedHostRevision: 4 }])('retains exact reviewed identity for %j', target => {
    expect(MachineAddSshStartInputSchema.parse({ ...target, enrollmentIdentity: identity })).toMatchObject({ enrollmentIdentity: identity });
  });
  it('keeps identity and administrator authority closed and passwords transient', () => {
    for (const enrollmentIdentity of [{ ...identity, username: 'root' }, { ...identity, administrator: { username: 'root' } },
      { ...identity, administrator: { username: 'operator', password: 'secret' } }]) {
      expect(MachineAddSshStartInputSchema.safeParse({ serverId: 'home', host: 'server', enrollmentIdentity }).success).toBe(false);
    }
    expect(MachineAddSshStartInputSchema.safeParse({ serverId: 'home', host: 'server', password: 'secret' }).success).toBe(false);
  });
  it('admits only a nonsecret reference to the current establishment prompt', () => {
    const input = { taskId: 'task', answer: { kind: 'administrator.establish', promptId: 'establish-1' } };
    expect(MachineAddSshRespondInputSchema.parse(input)).toEqual(input);
    expect(MachineAddSshRespondInputSchema.safeParse({ ...input, answer: { ...input.answer, password: 'secret' } }).success).toBe(false);
  });
  it('retains the existing personal enrollment input without requiring conversion', () => {
    expect(MachineAddSshStartInputSchema.parse({ serverId: 'home', host: 'personal' })).toEqual({ serverId: 'home', host: 'personal', username: '', authMode: 'agent' });
  });
});
