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

});
