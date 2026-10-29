import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { RunnerBrokerReadinessRequestV1Schema } from '@happier-dev/protocol/teams';

import { checkRunnerBrokerNonInferenceReadiness } from './runnerBrokerReadinessClient';

const request = RunnerBrokerReadinessRequestV1Schema.parse({
  v: 1,
  kind: 'provider_broker_readiness',
  homeServerIdentityId: 'srv_runner_home',
  activationId: '00000000-0000-4000-8000-000000000010',
  launchManifestCommitment: 'A'.repeat(43),
  resourceId: 'resource-1',
  agentTargetKey: 'agent:happier.agent.codex/codex',
  protocol: 'openai-responses',
  modelId: 'gpt-5',
  initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) },
  target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
  activationSignature: 'A'.repeat(86),
  installationSignature: 'A'.repeat(86),
});

const binding = {
  homeServerIdentityId: request.homeServerIdentityId,
  activationId: request.activationId,
  launchManifestCommitment: request.launchManifestCommitment,
  resourceId: request.resourceId,
  agentTargetKey: request.agentTargetKey,
  protocol: request.protocol,
  modelId: request.modelId,
  initiator: request.initiator,
  target: request.target,
};
const credentialSelectionBinding = {
  v: 1 as const,
  resourceId: request.resourceId,
  brokerMachineId: request.target.machineId,
  revision: 7,
  application: {
    agentTargetKey: request.agentTargetKey,
    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
    endpointTemplateId: 'responses',
    protocol: request.protocol,
  },
  sourceRevision: 'source-revision-7',
};

function harness(fetchImpl: typeof fetch, localPort = 48123) {
  const close = vi.fn(async () => undefined);
  const shutdown = vi.fn(async () => undefined);
  const openHttpTunnel = vi.fn(async () => ({
    localPort,
    localCapability: 'f'.repeat(64),
    remoteEndpointId: request.target.endpointId,
    observedPath: 'direct' as const,
    close,
  }));
  return {
    close,
    shutdown,
    openHttpTunnel,
    createRuntime: vi.fn(async () => ({
      available: true as const,
      endpoint: { endpointId: request.initiator.endpointId },
      openHttpTunnel,
      shutdown,
    })),
    fetchImpl,
  };
}

describe('Runner broker readiness client', () => {
  beforeEach(() => vi.stubEnv('HAPPIER_HOME_CARRIER_POLICY', 'automatic'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([302, 307, 200])('preserves HTTP %s semantics through the injected real fetch channel', async status => {
    let redirectedRequests = 0;
    let requests = 0;
    const server = createServer((incoming, response) => {
      incoming.resume();
      if (incoming.url === '/redirected') {
        redirectedRequests += 1;
        response.end('{}');
      } else {
        requests += 1;
        if (status === 200) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ v: 1, binding, credentialSelectionBinding, readiness: { kind: 'available' } }));
        } else {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Missing server address');
          response.writeHead(status, { location: `http://localhost:${address.port}/redirected` });
          response.end();
        }
      }
    });
    server.listen(0);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const h = harness(vi.fn<typeof fetch>((...args) => fetch(...args)), address.port);
    try {
      const result = checkRunnerBrokerNonInferenceReadiness({ createRequest: () => request,
        target: { endpointId: request.target.endpointId }, happyHomeDir: '/runner-home',
        signal: new AbortController().signal, createRuntime: h.createRuntime, fetchImpl: h.fetchImpl });
      if (status === 200) await expect(result).resolves.toEqual({ kind: 'available' });
      else await expect(result).rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status });
      expect(requests).toBe(1);
      expect(redirectedRequests).toBe(0);
      expect(h.close).toHaveBeenCalledOnce();
      expect(h.shutdown).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('reports broker unavailable without creating a native endpoint under Standard-only policy', async () => {
    vi.stubEnv('HAPPIER_HOME_CARRIER_POLICY', 'standard_only');
    const h = harness(vi.fn<typeof fetch>(async () => Response.json({
      v: 1, binding, credentialSelectionBinding, readiness: { kind: 'available' },
    })));

    await expect(checkRunnerBrokerNonInferenceReadiness({
      createRequest: () => request,
      target: { endpointId: request.target.endpointId },
      happyHomeDir: '/runner-home',
      signal: new AbortController().signal,
      createRuntime: h.createRuntime,
      fetchImpl: h.fetchImpl,
    })).resolves.toEqual({ kind: 'broker_unavailable' });
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('posts only the signed readiness request through the existing HTTP carrier and closes everything', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.body).toBe(JSON.stringify(request));
      expect(init?.headers).toEqual(expect.objectContaining({
        'content-type': 'application/json',
        'x-happier-machine-local-capability': 'f'.repeat(64),
      }));
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('prompt');
      return Response.json({ v: 1, binding, credentialSelectionBinding, readiness: { kind: 'available' } });
    });
    const h = harness(fetchImpl);
    await expect(checkRunnerBrokerNonInferenceReadiness({
      createRequest: (initiatorEndpointId) => {
        expect(initiatorEndpointId).toBe(request.initiator.endpointId);
        return request;
      },
      target: { endpointId: request.target.endpointId },
      happyHomeDir: '/runner-home',
      signal: new AbortController().signal,
      createRuntime: h.createRuntime,
      fetchImpl,
    })).resolves.toEqual({ kind: 'available' });
    expect(h.openHttpTunnel).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
  });

  it('closes the temporary tunnel and endpoint when the request is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      controller.abort(reason);
      throw reason;
    });
    const h = harness(fetchImpl);
    await expect(checkRunnerBrokerNonInferenceReadiness({
      createRequest: (initiatorEndpointId) => {
        expect(initiatorEndpointId).toBe(request.initiator.endpointId);
        return request;
      },
      target: { endpointId: request.target.endpointId },
      happyHomeDir: '/runner-home',
      signal: controller.signal,
      createRuntime: h.createRuntime,
      fetchImpl,
    })).rejects.toBe(reason);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
  });

  it.each([
    [403, 'policy_denied'],
    [503, 'broker_unavailable'],
  ] as const)('maps bodyless effect status %s to canonical %s readiness and cleans up', async (status, kind) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status }));
    const h = harness(fetchImpl);
    await expect(checkRunnerBrokerNonInferenceReadiness({
      createRequest: () => request,
      target: { endpointId: request.target.endpointId },
      happyHomeDir: '/runner-home',
      signal: new AbortController().signal,
      createRuntime: h.createRuntime,
      fetchImpl,
    })).resolves.toEqual({ kind });
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
  });
});
