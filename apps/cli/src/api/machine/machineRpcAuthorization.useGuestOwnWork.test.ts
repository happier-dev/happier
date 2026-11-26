import { describe, expect, it } from 'vitest';
import { MACHINE_RPC_ROUTE_POLICIES } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipCreateRpcRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSeedRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import {
  authorizeMachineRpcRequest,
  doesWorkspaceSyncSeedRootMatchRouting,
  type MachineRpcAdmissionBoundary,
} from './machineRpcAuthorization';

// Owner ruling 2026-11-23 ~15:10Z: on a Machine whose owner turned isolation off,
// Use admits a guest's own Project and Session work. Home's admission (role and
// method) is the network boundary here; the receiving admission, identity
// selection and placement owner stay real.
const guest = {
  actorAccountId: 'guest',
  custodianAccountId: 'owner',
  machineId: 'machine',
  installationId: 'installation',
  role: 'use' as const,
  encryptionMode: 'plain' as const,
};
type Policy = ReturnType<
  NonNullable<MachineRpcAdmissionBoundary['readAgentIsolation']>
>;
const boundary = (
  readAgentIsolation?: () => Policy,
): MachineRpcAdmissionBoundary => ({
  machineId: 'machine',
  resolveInstallationId: () => 'installation',
  resolveHomeServerIdentityId: async () => 'home',
  resolveCustodianAccountId: async () => 'owner',
  verifyMachineAdmission: async () => true,
  ...(readAgentIsolation ? { readAgentIsolation } : {}),
});
const ISOLATION_PHASE = 'rpc.admission.requester_execution_isolation';
// Every Use route the route policy marks requester-isolated: the route classes come
// from the owner's table, never a hand-copied method list.
const useIsolatedRoutes = MACHINE_RPC_ROUTE_POLICIES.filter(
  (policy) =>
    policy.sharedMachineAccess === 'use' &&
    policy.requesterExecutionIsolationRequired === true,
).map((policy) => policy.method);

async function refusedAtIsolation(
  readAgentIsolation: (() => Policy) | undefined,
  callerAuthority: 'present_user' | 'account_automation' = 'present_user',
) {
  const refused: Array<{ method: string; errorCode: string }> = [];
  for (const method of useIsolatedRoutes) {
    const result = await authorizeMachineRpcRequest(
      {
        method: `machine:${method}`,
        params: {},
        machineAdmission: guest,
        callerAuthority,
      },
      boundary(readAgentIsolation),
    );
    if (!result.ok && result.failureCause?.phase === ISOLATION_PHASE)
      refused.push({ method, errorCode: result.errorCode ?? '' });
  }
  return refused;
}

describe('Use guest own work on an isolation-off Machine', () => {
  it('admits the guest at the one requester-isolation admission only when the owner turned isolation off', async () => {
    // Baseline: with isolation enabled (whether effective or expected but unavailable)
    // or with no readable policy, the requester-isolation admission refuses the guest.
    const enabled = await refusedAtIsolation(() => ({ enabled: true }));
    const unread = await refusedAtIsolation(undefined);
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.map((row) => row.errorCode)).toEqual(
      expect.arrayContaining([
        'agent_isolation_unavailable',
        'machine_manage_required',
      ]),
    );
    expect(unread.map((row) => row.method)).toEqual(
      enabled.map((row) => row.method),
    );
    // Isolation off: the same admission refuses none of those routes.
    expect(await refusedAtIsolation(() => ({ enabled: false }))).toEqual([]);
    // With isolation on, a local commit is admitted to run in the guest's member child ("Use works
    // inside isolation"); network source control keeps the Manage refusal.
    expect(enabled.find((row) => row.method === RPC_METHODS.SCM_COMMIT_CREATE)).toBeUndefined();
    expect(
      enabled.find((row) => row.method === RPC_METHODS.SCM_REMOTE_PUSH)
        ?.errorCode,
    ).toBe('machine_manage_required');
  });

  it('keeps an Agent of the guest under the same placement decision', async () => {
    const sessionActionOrigin = {
      v: 1 as const,
      caller: {
        kind: 'session' as const,
        sessionId: 'guest-session',
        starterDepth: 0,
        turnDepth: 0,
      },
      sourceTurnId: 'turn',
      callerPermissionMode: 'default' as const,
      requestId: 'guest-agent',
    };
    const request = {
      method: `machine:${RPC_METHODS.SCM_COMMIT_CREATE}`,
      params: {},
      machineAdmission: guest,
      callerAuthority: 'present_user' as const,
      sessionActionOrigin,
    };
    // Shape: one admission reads the Machine policy once and checks Home's admission once.
    let policyReads = 0;
    let homeChecks = 0;
    const counted = { ...boundary(() => { policyReads += 1; return { enabled: false }; }),
      verifyMachineAdmission: async () => { homeChecks += 1; return true; } };
    expect(await authorizeMachineRpcRequest(request, counted)).toMatchObject({ ok: true });
    expect({ policyReads, homeChecks }).toEqual({ policyReads: 1, homeChecks: 1 });
    expect(
      await authorizeMachineRpcRequest(
        request,
        boundary(() => ({ enabled: false })),
      ),
    ).toEqual({
      ok: true,
      directWorkspaceRequester: expect.objectContaining({
        kind: 'isolated',
        requester: expect.objectContaining({ accountId: 'guest' }),
      }),
    });
    expect(
      await authorizeMachineRpcRequest(
        request,
        boundary(() => ({ enabled: true })),
      ),
    ).toMatchObject({ ok: false, errorCode: 'machine_manage_required' });
  });

  it('places a Keep-updated Replica on the daemon only when the owner turned isolation off', async () => {
    const content = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const create = (mode: 'keep_synced' | 'keep_both_in_sync', replaceRelationshipId?: string) => WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse({
      v: 1, operationId: 'replica', actionInput: { v: 1, sourceWorkspaceRefId: 'source-ref', targetMachineId: 'guest-machine',
        targetPath: '/home/guest/replica', mode, destinationIntent: 'use_existing',
        ...(replaceRelationshipId ? { replaceRelationshipId } : {}),
        contentPolicy: { ...content, policyDigest: computeWorkspaceSyncPolicyDigest(content) } } });
    const admit = (mode: 'keep_synced' | 'keep_both_in_sync', enabled: boolean, role: 'use' | 'manage' = 'use', replaceRelationshipId?: string) =>
      authorizeMachineRpcRequest({ method: `machine:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
        params: create(mode, replaceRelationshipId), machineAdmission: { ...guest, role }, callerAuthority: 'present_user' },
      boundary(() => ({ enabled })));
    expect(await admit('keep_synced', false)).toEqual({ ok: true, directWorkspaceRequester: expect.objectContaining({
      kind: 'isolated', requester: expect.objectContaining({ accountId: 'guest' }) }) });
    // Isolation on: the native member-capture owner keeps deciding the requester's placement.
    expect(await admit('keep_synced', true)).toEqual({ ok: true });
    // A two-way link writes back into the owner's checkout; it is not this Replica.
    expect(await admit('keep_both_in_sync', false)).toEqual({ ok: true });
    // Replace stays off daemon placement for Use even on an isolation-off Machine (B21 N1).
    expect(await admit('keep_synced', false, 'use', 'existing-link')).toEqual({ ok: true });
    // Manage keeps its existing native placement.
    expect(await admit('keep_synced', true, 'manage')).toMatchObject({ ok: true });
  });

  it('admits a Use guest session.handoff Git seed only into the guest own Machine and refuses foreign targets', () => {
    const buildSeed = (
      targetCustodian: string,
      sourceRole: 'use' | 'manage' = 'use',
      sourceCustodian = 'owner',
      bindingRole: 'use' | 'manage' | 'omit' = sourceRole,
    ) => {
      const sourceAdmission = { ...guest, custodianAccountId: sourceCustodian, role: sourceRole };
      const targetAdmission = {
        actorAccountId: 'guest', custodianAccountId: targetCustodian,
        machineId: 'target-machine', installationId: 'target-installation',
        role: targetCustodian === 'guest' ? 'manage' as const : 'use' as const,
        encryptionMode: 'plain' as const,
      };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1, token: 'handoff-root',
        binding: {
          accountId: 'guest', custodianAccountId: sourceCustodian,
          ...(bindingRole !== 'omit' ? { admittedMachineRole: bindingRole } : {}),
          authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
          serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
          actionId: 'session.handoff', requestId: 'handoff-op', requestEnvelopeDigest: 'A'.repeat(43),
          target: { kind: 'machine', machineId: 'machine' },
          handoffAdmission: { sessionId: 'guest-session', sourceMachineId: 'machine', sourceInstallationId: 'installation', targetMachineId: 'target-machine', targetInstallationId: 'target-installation' },
        },
      });
      const source = {
        v: 1 as const, phase: 'prepare' as const, operationId: 'handoff-op', accountServerId: 'home',
        sourceSessionId: 'guest-session', sourceMachineId: 'machine', sourceRootPath: '/repo',
        sourceContext: { machineAdmission: sourceAdmission, callerAuthority: 'present_user' as const },
      };
      const targetPhase = {
        v: 1 as const, phase: 'prepare' as const, operationId: 'handoff-op', accountServerId: 'home',
        targetMachineId: 'target-machine', targetRootPath: '/guest/repo',
      };
      const seed = WorkspaceSyncSeedRoutingV1Schema.parse({
        v: 1,
        sourceWriterTarget: {
          v: 1, source,
          sourceWriter: { machineId: 'machine', installationId: 'installation' },
          target: targetPhase,
        },
        target: {
          ...targetPhase,
          targetContext: { machineAdmission: targetAdmission, callerAuthority: 'present_user' as const },
        },
      });
      return { authorization, seed };
    };
    const own = buildSeed('guest');
    expect(doesWorkspaceSyncSeedRootMatchRouting(own.authorization, own.seed, undefined, 'handoff-op')).toBe(true);
    // Rejects unexpected sourceExecution packet on writer_target proof.
    expect(doesWorkspaceSyncSeedRootMatchRouting(own.authorization, own.seed, {} as never, 'handoff-op')).toBe(false);
    // Cross-Account Use guest targeting another person's Machine is refused.
    const foreign = buildSeed('other-owner');
    expect(doesWorkspaceSyncSeedRootMatchRouting(foreign.authorization, foreign.seed, undefined, 'handoff-op')).toBe(false);
    // Cross-Account Manage grantee keeps existing admission.
    const manage = buildSeed('other-owner', 'manage', 'owner', 'manage');
    expect(doesWorkspaceSyncSeedRootMatchRouting(manage.authorization, manage.seed, undefined, 'handoff-op')).toBe(true);
    // Forging sourceContext.machineAdmission.role = manage on a Use-guest (or omitted-role cross-Account) root is refused.
    const forgedFromUse = buildSeed('other-owner', 'manage', 'owner', 'use');
    expect(doesWorkspaceSyncSeedRootMatchRouting(forgedFromUse.authorization, forgedFromUse.seed, undefined, 'handoff-op')).toBe(false);
    const forgedWithoutBindingRole = buildSeed('other-owner', 'manage', 'owner', 'omit');
    expect(doesWorkspaceSyncSeedRootMatchRouting(forgedWithoutBindingRole.authorization, forgedWithoutBindingRole.seed, undefined, 'handoff-op')).toBe(false);
  });
});
