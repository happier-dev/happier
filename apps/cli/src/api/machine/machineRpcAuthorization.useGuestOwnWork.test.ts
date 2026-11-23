import { describe, expect, it } from 'vitest';
import { MACHINE_RPC_ROUTE_POLICIES } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import {
  authorizeMachineRpcRequest,
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
    // Source control in the guest's own repository no longer needs Manage there.
    expect(
      enabled.find((row) => row.method === RPC_METHODS.SCM_COMMIT_CREATE)
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
      directScmWorkspaceRequester: expect.objectContaining({
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
});
