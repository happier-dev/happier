import { describe, expect, it } from 'vitest';

import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../../rpc/methods.js';
import { resolveMachineRpcGovernance } from './governanceV1.js';

describe('plugin transport authority', () => {
  it('keeps capture discovery read-only and contributed execution behind authenticated ingress', async () => {
    expect(resolveMachineRpcGovernance(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ)).toEqual({ rpcClassification: 'internal_only' });
    expect(resolveMachineRpcGovernance(RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE)).toEqual({ rpcClassification: 'internal_only' });
    const { resolveMachineRpcRoutePolicy, resolveMachineRpcExternalActionEffectV1 } = await import('./routePolicyV1.js');
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ)).toMatchObject({
      routeClass: 'direct_ephemeral', rpcClassification: 'internal_only',
      scope: { accountRequired: true, machineRequired: true, serverRequired: false },
    });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE)).toMatchObject({
      routeClass: 'server_required', serverRequiredReason: 'auth', rpcClassification: 'internal_only',
      scope: { accountRequired: true, machineRequired: true, serverRequired: true },
    });
    expect(resolveMachineRpcExternalActionEffectV1(RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ)).toBeNull();
    expect(resolveMachineRpcExternalActionEffectV1(RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE)).toBeNull();
  });

  it('requires exact Session authority for catalog invalidation and native CLI attachment', async () => {
    for (const method of [SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1,
      SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE]) {
      expect(resolveMachineRpcGovernance(method)).toEqual({ rpcClassification: 'internal_only' });
      const { resolveMachineRpcRoutePolicy, resolveMachineRpcExternalActionEffectV1 } = await import('./routePolicyV1.js');
      expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({
        routeClass: 'server_required', serverRequiredReason: 'auth', rpcClassification: 'internal_only',
        scope: { accountRequired: true, machineRequired: true, serverRequired: true },
      });
      expect(resolveMachineRpcExternalActionEffectV1(method)).toBeNull();
    }
  });
});
