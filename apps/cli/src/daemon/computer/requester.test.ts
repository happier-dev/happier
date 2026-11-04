import { describe, expect, it } from 'vitest';
import { resolveComputerRequesterScope, type ComputerRequesterHost } from './requester';
import type { ComputerActionContext } from './routes';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';

const host: ComputerRequesterHost = {
  custodianAccountId: 'owner', installationId: 'installation',
  readHomeServerIdentityId: async () => 'home',
  prepareNativeOperation: async () => { throw new Error('No effect during scope selection'); },
};
function context(accountId: string, role: 'use' | 'manage' = 'use'): ComputerActionContext {
  return { authority: 'present_user', defaultSessionId: 'session',
    machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', role,
      machineId: 'machine', installationId: 'installation', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
}

describe('Computer requester desktop admission', () => {
  it('preserves owner and Manage display authority while personal ingress cannot borrow it', async () => {
    for (const caller of [context('owner'), context('guest', 'manage')]) {
      expect(await resolveComputerRequesterScope({ machineId: 'machine', host, context: caller })).toEqual({ kind: 'owner' });
      await expect(resolveComputerRequesterScope({ machineId: 'machine', host,
        context: { ...caller, ownDesktopOnly: true } })).rejects.toMatchObject({ code: 'access_denied' });
    }
  });

  it('does not recover an arbitrary payload Session before admitting an owner or Manage caller', async () => {
    for (const caller of [context('owner'), context('guest', 'manage')]) {
      expect(await resolveComputerRequesterScope({ machineId: 'machine', context: caller,
        host: { ...host, readSessionBootstrap: async () => { throw new Error('Unrelated Session birth'); } } }))
        .toEqual({ kind: 'owner' });
    }
  });

  it('keys Linux desktops by person even when both guests use daemon placement', async () => {
    const first = await resolveComputerRequesterScope({ machineId: 'machine', host, context: context('guest'), platform: 'linux' });
    const same = await resolveComputerRequesterScope({ machineId: 'machine', host,
      context: { ...context('guest'), defaultSessionId: 'other-session' }, platform: 'linux' });
    const other = await resolveComputerRequesterScope({ machineId: 'machine', host, context: context('other'), platform: 'linux' });
    expect(first).toMatchObject({ kind: 'personal', placement: 'daemon', identity: { requester: { accountId: 'guest' } } });
    expect(same).toEqual(first);
    expect(other).toMatchObject({ kind: 'personal', placement: 'daemon' });
    if (first.kind !== 'personal' || other.kind !== 'personal') throw new Error('Expected personal desktops');
    expect(other.key).not.toBe(first.key);
  });

  it('returns typed unavailable for guest desktop on macOS and Windows without using owner authority', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      await expect(resolveComputerRequesterScope({ machineId: 'machine', host, context: context('guest'), platform }))
        .rejects.toMatchObject({ code: 'computer_display_unavailable' });
    }
  });

  it('refuses a guest when host custody or the requester identity cannot be bound', async () => {
    await expect(resolveComputerRequesterScope({ machineId: 'machine', context: context('guest') }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    await expect(resolveComputerRequesterScope({ machineId: 'machine', host,
      context: { ...context('guest'), verifyMachineAdmissionCurrent: undefined } }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });

  it('binds the personal viewer to its caller even when a supplied Session belongs to someone else', async () => {
    // The tracked-Session boundary supplies only the birth fields this owner reads.
    const otherBootstrap = { attribution: { serverId: 'home', accountId: 'other', machineId: 'machine', installationId: 'installation' },
      homeServerIdentityId: 'home', savedSecretOperationContext: { machineAdmission: {
        actorAccountId: 'other', custodianAccountId: 'owner', role: 'use',
      } } } as unknown as AdmittedRequesterSessionBootstrap;
    const viewer = await resolveComputerRequesterScope({ machineId: 'machine',
      host: { ...host, readSessionBootstrap: () => otherBootstrap },
      context: { ...context('guest'), ownDesktopOnly: true }, platform: 'linux' });
    expect(viewer).toMatchObject({ kind: 'personal', identity: { requester: { accountId: 'guest' } } });
  });

  it('awaits recovered Session birth and never falls back to owner on an unavailable birth read', async () => {
    // Persisted requester custody is an OS/account boundary; keep selection real.
    const bootstrap = { attribution: { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' },
      homeServerIdentityId: 'home', savedSecretOperationContext: { machineAdmission: context('guest').machineAdmission } } as unknown as AdmittedRequesterSessionBootstrap;
    const recovered = await resolveComputerRequesterScope({ machineId: 'machine', platform: 'linux',
      context: { defaultSessionId: 'session' }, host: { ...host, readSessionBootstrap: async () => bootstrap } });
    expect(recovered).toMatchObject({ kind: 'personal', identity: { requester: { accountId: 'guest' } } });
    await expect(resolveComputerRequesterScope({ machineId: 'machine', platform: 'linux',
      context: { defaultSessionId: 'session' }, host: { ...host, readSessionBootstrap: async () => {
        throw Object.assign(new Error('Requester birth unavailable'), { code: 'agent_isolation_unavailable' });
      } } })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
  });
});
