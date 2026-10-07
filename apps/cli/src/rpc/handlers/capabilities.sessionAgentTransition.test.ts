import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse } from '@/capabilities/types';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

const request: CapabilitiesDetectRequest = { requests: [{ id: 'tool.sessionAgentTransition' }] };

describe('Agent transition input permission capability', () => {
  it('leaves the daemon-only capability unavailable on session-process registrations', async () => {
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'session-capabilities',
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });
    const result = await call<CapabilitiesDetectResponse, CapabilitiesDetectRequest>(RPC_METHODS.CAPABILITIES_DETECT, request);
    expect(result.results['tool.sessionAgentTransition']).toMatchObject({
      ok: false, error: { code: 'unknown-capability' },
    });
  });

  it('reports input permission support only while the daemon transition handler is registered', async () => {
    const { call, manager } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-capabilities',
      registerHandlers: (rpcManager) => registerCapabilitiesHandlers(rpcManager, {
        hasSessionAgentTransition: () => rpcManager.hasHandler(RPC_METHODS.SESSION_AGENT_TRANSITION),
      }),
    });
    const beforeRegistration = await call<CapabilitiesDetectResponse, CapabilitiesDetectRequest>(RPC_METHODS.CAPABILITIES_DETECT, request);
    expect(beforeRegistration.results['tool.sessionAgentTransition']).toMatchObject({
      ok: true, data: { supportsInputPermissionIntent: false },
    });

    // Registration is the RPC transport boundary; this handler is never invoked.
    // The coordinator's real permission preflight has its own regression cases.
    manager.registerHandler(RPC_METHODS.SESSION_AGENT_TRANSITION, () => undefined);
    const afterRegistration = await call<CapabilitiesDetectResponse, CapabilitiesDetectRequest>(RPC_METHODS.CAPABILITIES_DETECT, request);
    expect(afterRegistration.results['tool.sessionAgentTransition']).toMatchObject({
      ok: true, data: { supportsInputPermissionIntent: true },
    });
  });
});
