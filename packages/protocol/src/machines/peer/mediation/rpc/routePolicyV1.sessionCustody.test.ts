import { describe, expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc/methods.js';
import { resolveMachineRpcRoutePolicy } from './routePolicyV1.js';

describe('requester Session RPC admission', () => {
  it('admits manual compaction with Use while retaining its Session Action authority', () => {
    expect(resolveMachineRpcRoutePolicy(SESSION_RPC_METHODS.SESSION_COMPACT)).toMatchObject({
      routeClass: 'server_required',
      sharedMachineAccess: 'use',
      serverRequiredReason: 'auth',
      rpcClassification: 'action_spec_bound',
      actionSpecId: 'session.compact',
    });
  });

  it('admits an internal child with Use while its retained parent owns requester custody', () => {
    const policy = resolveMachineRpcRoutePolicy(RPC_METHODS.UI_ACTION_CHILD_EXECUTE);
    expect(policy).toMatchObject({
      routeClass: 'server_required',
      sharedMachineAccess: 'use',
      serverRequiredReason: 'auth',
      rpcClassification: 'internal_only',
    });
    expect(policy.actionSpecId).toBeUndefined();
    expect(policy.ephemeralRunnerAuthority).toBeUndefined();
  });
});
