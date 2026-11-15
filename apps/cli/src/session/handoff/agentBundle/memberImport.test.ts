import { expect, it, vi } from 'vitest';
import type { RpcHandlerContext } from '@/api/rpc/types';
import {
  prepareMemberSessionHandoffImport,
  type MemberSessionHandoffImportDeps,
} from './memberImport';

// The native member directory is an OS boundary; the capture decision,
// placement policy and folder rule stay real. The policy names no member binary,
// so any launch attempt would surface as agent_isolation_unavailable.
function deps(
  policy: Readonly<{ enabled: boolean; memberProvisioning?: string }>,
) {
  const readMember = vi.fn(async () => ({
    identity: {
      home: '/home/hpm-member',
      workspaceRoot: '/srv/happier/members/member-a',
    },
  }));
  return {
    readMember,
    deps: {
      platform: 'linux',
      resolveHostHomeServerIdentityId: async () => 'home',
      agentIsolation: {
        read: () => policy,
        readMember,
      } as unknown as NonNullable<
        MemberSessionHandoffImportDeps['agentIsolation']
      >,
    } satisfies MemberSessionHandoffImportDeps,
  };
}

function context(
  admission: Readonly<{
    actorAccountId: string;
    custodianAccountId: string;
    role: 'use' | 'manage';
  }>,
): RpcHandlerContext {
  return {
    signal: new AbortController().signal,
    callerAuthority: 'account_automation',
    verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: {
      ...admission,
      machineId: 'host-machine',
      installationId: 'host-installation',
      encryptionMode: 'plain',
    },
  };
}

it('keeps host import for the custodian, Manage and Machines without separate users', async () => {
  const separate = deps({ enabled: true, memberProvisioning: 'linuxUsersV1' });
  expect(
    await prepareMemberSessionHandoffImport(
      context({
        actorAccountId: 'host',
        custodianAccountId: 'host',
        role: 'manage',
      }),
      separate.deps,
    ),
  ).toBeUndefined();
  expect(
    await prepareMemberSessionHandoffImport(
      context({
        actorAccountId: 'member-a',
        custodianAccountId: 'host',
        role: 'manage',
      }),
      separate.deps,
    ),
  ).toBeUndefined();
  const shared = deps({ enabled: true });
  expect(
    await prepareMemberSessionHandoffImport(
      context({
        actorAccountId: 'member-a',
        custodianAccountId: 'host',
        role: 'use',
      }),
      shared.deps,
    ),
  ).toBeUndefined();
  expect(separate.readMember).not.toHaveBeenCalled();
});

it('imports a Can use handoff as the member and refuses any path outside the member folder before a launch', async () => {
  const separate = deps({ enabled: true, memberProvisioning: 'linuxUsersV1' });
  const prepared = await prepareMemberSessionHandoffImport(
    context({
      actorAccountId: 'member-a',
      custodianAccountId: 'host',
      role: 'use',
    }),
    separate.deps,
  );
  expect(prepared?.workspaceRoot).toBe('/srv/happier/members/member-a');
  await expect(
    prepared!.import({
      bundle: { agentId: 'claude' } as never,
      targetPath: '/home/host/.ssh',
      sessionStorageMode: 'persisted',
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'workspace_private_checkout_review_required' });
});
