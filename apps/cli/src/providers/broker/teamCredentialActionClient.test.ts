import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ProviderBrokerActionOpenResponseV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { executeTeamCredentialBrokerAction } from './teamCredentialActionClient';

const actionInput = {
  teamId: 'team', selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' },
  action: { pluginId: 'acme.cloud', localId: 'options' },
  purpose: { consumer: { pluginId: 'acme.cloud', localId: 'options' }, purpose: 'cloud-api' },
  pluginVersion: '1.0.0', operationId: 'operation', input: {},
  initiatorMachineId: 'consumer',
} as const;

function opened(): Extract<ProviderBrokerActionOpenResponseV3, { ok: true }> {
  return {
    ok: true,
    authority: {
      payload: { v: 3, aud: 'happier-provider-broker-action-v3', grantId: 'grant', issuedAt: 1, expiresAt: 2,
        teamId: 'team', resourceId: 'resource',
        inputDigest: computeActionInputApprovalDigestV1('acme.cloud/actions/options', {}),
        source: { v: 1, kind: 'connected_account', target: { kind: 'account',
          account: { service: { pluginId: 'acme.cloud', localId: 'cloud' }, accountId: 'source-account' } }, credentialIncarnation: 'incarnation' },
        consumer: { kind: 'action_operation', operationId: actionInput.operationId,
          actionId: 'acme.cloud/actions/options', pluginVersion: actionInput.pluginVersion, purpose: actionInput.purpose },
        declaration: { version: '1.0.0', manifestDigestSha256: `sha256:${'a'.repeat(64)}` },
        initiator: { accountId: 'requester', machineId: 'consumer', endpointId: 'a'.repeat(64) },
        target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) } },
      signature: { alg: 'Ed25519', keyId: 'key', valueBase64Url: Buffer.alloc(64).toString('base64url') },
    },
    target: { custodianAccountId: 'custodian', brokerMachineId: 'broker', endpointId: 'b'.repeat(64),
      endpointRevision: 1, endpoint: { endpointId: 'b'.repeat(64) } },
  };
}

describe('finite Team broker Action client', () => {
  it.each(['open', 'execute'] as const)('retains the typed cause from a broker %s refusal', async phase => {
    const failureCause = { phase: 'provider.source_open', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const refusal = { ok: false as const, reasonCode: 'broker_unavailable' as const, failureCause };
    await expect(executeTeamCredentialBrokerAction({ ...actionInput, signal: new AbortController().signal,
      openBroker: async () => phase === 'open' ? refusal : opened(),
      openTunnel: async () => ({ localPort: 1234, localCapability: 'capability', observedPath: 'direct',
        retire: async () => {}, close: async () => {} }),
      fetchImpl: async () => Response.json(refusal, { status: 503 }),
    })).rejects.toMatchObject({ code: 'broker_unavailable', data: { failureCause } });
  });

  it('keeps a Home refusal typed and never opens a credential fallback', async () => {
    let tunnels = 0;
    await expect(executeTeamCredentialBrokerAction({
      teamId: 'team', selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' },
      action: { pluginId: 'acme.cloud', localId: 'options' },
      purpose: { consumer: { pluginId: 'acme.cloud', localId: 'options' }, purpose: 'cloud-api' },
      pluginVersion: '1.0.0', operationId: 'operation', input: {}, signal: new AbortController().signal,
      initiatorMachineId: 'consumer',
      openBroker: async () => ({ ok: false, reasonCode: 'resource_forbidden' }),
      openTunnel: async () => { tunnels += 1; throw new Error('unexpected tunnel'); },
    })).rejects.toMatchObject({ code: 'resource_forbidden' });
    expect(tunnels).toBe(0);
  });

  it('preserves the declared Action failure and closes its finite carrier', async () => {
    const execution = { ok: false, errorCode: 'provider_quota_exhausted', error: 'Provider quota exhausted',
      details: { name: 'PluginError', code: 'provider_quota_exhausted', retryable: true, details: { remedy: 'change-plan' } } } as const;
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, execution }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing Action listener');
    let closed = false;
    try {
      await expect(executeTeamCredentialBrokerAction({ ...actionInput, signal: new AbortController().signal,
        // Home and the native carrier are network/OS boundaries. The client
        // parsing and HTTP execution path remain real in this focused check.
        openBroker: async () => opened(), openTunnel: async () => ({ localPort: address.port,
          localCapability: 'local-capability', observedPath: 'direct', retire: async () => undefined,
          close: async () => { closed = true; } }),
      })).resolves.toEqual(execution);
      expect(requests).toEqual([{ input: {} }]);
      expect(closed).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('refuses a grant for different reviewed operands before a carrier or handler effect', async () => {
    const original = opened();
    const authority = { ...original, authority: { ...original.authority, payload: { ...original.authority.payload,
      inputDigest: computeActionInputApprovalDigestV1('acme.cloud/actions/options', { changed: true }) } } };
    let effects = 0;
    await expect(executeTeamCredentialBrokerAction({ ...actionInput, signal: new AbortController().signal,
      openBroker: async () => authority,
      beforeHandlerInvocation: () => { effects += 1; },
      openTunnel: async () => { effects += 1; throw new Error('unexpected carrier'); },
    })).rejects.toMatchObject({ code: 'broker_binding_changed' });
    expect(effects).toBe(0);
  });
});
