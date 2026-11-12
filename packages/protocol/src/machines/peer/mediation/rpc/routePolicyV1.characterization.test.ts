import { expect, it } from 'vitest';

import { MACHINE_RPC_ROUTE_POLICIES, resolveMachineRpcRoutePolicy } from './routePolicyV1.js';

it('preserves every declared method and complete effective policy through declaration consolidation', () => {
  // Captured before removing the access overlays; includes duplicate rows and
  // all fields, so a lost method, custody fact or route distinction is visible.
  // RPC-GOV-SECRET-1112 repairs the native vault row to internal_only;
  // its Manage intent is unchanged (83c145e74d2, docs/encryption.md).
  expect(MACHINE_RPC_ROUTE_POLICIES).toMatchSnapshot();
  expect(resolveMachineRpcRoutePolicy('unknown.method')).toMatchObject({
    routeClass: 'server_required', sharedMachineAccess: 'custodian_only', serverRequiredReason: 'unclassified',
  });
  // Complete pre-refactor fallback from the captured policy source, including
  // isolation retained for cli-v0.2.17's unregistered raw Session method.
  expect(resolveMachineRpcRoutePolicy('ripgrep')).toEqual({
    method: 'ripgrep',
    routeClass: 'server_required',
    rationale: 'No deployed PMS-5 route policy row exists for this method; deny direct by default.',
    ownerPacket: 'PMS-5',
    rpcClassification: 'advisory_unclassified',
    sharedMachineAccess: 'custodian_only',
    scope: { accountRequired: true, machineRequired: true, serverRequired: true },
    serverRequiredReason: 'unclassified',
    requesterExecutionIsolationRequired: true,
  });
});
