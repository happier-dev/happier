import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerRunnerBrokerReadinessApplication } from './runnerBrokerReadinessApplication';

describe('Runner broker readiness application', () => {
  const credentialSelectionBinding = {
    v: 1 as const,
    resourceId: 'resource-1', brokerMachineId: 'broker-machine', revision: 7,
    application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' as const },
    sourceRevision: 'source-revision-7',
  };

  it('forwards only the strict signed readiness envelope to Home custody and returns safe readiness', async () => {
    const authorize = vi.fn(async () => ({
      v: 1 as const,
      binding: {
        homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses' as const, modelId: 'gpt-5',
        initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      },
      credentialSelectionBinding,
      readiness: { kind: 'available' as const },
    }));
    const checkLocalCurrentness = vi.fn(async () => ({ kind: 'available' as const }));
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, { authorize, checkLocalCurrentness });
    const body = {
      v: 1, kind: 'provider_broker_readiness', homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) }, activationSignature: 'A'.repeat(86), installationSignature: 'A'.repeat(86),
    };
    const response = await app.inject({ method: 'POST', url: '/readiness', payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      v: 1,
      readiness: { kind: 'available' },
    }));
    expect(authorize).toHaveBeenCalledWith(body, expect.any(AbortSignal));
    expect(checkLocalCurrentness).toHaveBeenCalledWith({ selection: credentialSelectionBinding, modelId: 'gpt-5' }, expect.any(AbortSignal));
    expect(JSON.stringify(authorize.mock.calls[0])).not.toContain('prompt');
    expect(JSON.stringify(authorize.mock.calls[0])).toContain('"modelId":"gpt-5"');
    await app.close();
  });

  it.each([
    [{ kind: 'source_unavailable' }, { kind: 'source_unavailable' }],
    [{ kind: 'update_required' }, { kind: 'update_required' }],
    [{ kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' }, { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' }],
  ] as const)('downgrades Home availability when exact local currentness is %s', async (local, expected) => {
    const authorize = vi.fn(async () => ({
      v: 1 as const,
      binding: {
        homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses' as const, modelId: 'gpt-5',
        initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      },
      credentialSelectionBinding,
      readiness: { kind: 'available' as const },
    }));
    const checkLocalCurrentness = vi.fn(async () => local);
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, { authorize, checkLocalCurrentness });
    const response = await app.inject({ method: 'POST', url: '/readiness', payload: {
      v: 1, kind: 'provider_broker_readiness', homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) }, activationSignature: 'A'.repeat(86), installationSignature: 'A'.repeat(86),
    } });
    expect(response.json().readiness).toEqual(expected);
    expect(checkLocalCurrentness).toHaveBeenCalledWith({ selection: credentialSelectionBinding, modelId: 'gpt-5' }, expect.any(AbortSignal));
    await app.close();
  });

  it('retains a confirmed Home source reconnect without asking local currentness', async () => {
    const readiness = { kind: 'source_unavailable' as const, reason: 'connected_service_credential_reconnect_required' as const };
    const body = {
      v: 1, kind: 'provider_broker_readiness', homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses' as const, modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) }, activationSignature: 'A'.repeat(86), installationSignature: 'A'.repeat(86),
    };
    const checkLocalCurrentness = vi.fn();
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, { authorize: async () => ({ v: 1,
      binding: { homeServerIdentityId: body.homeServerIdentityId, activationId: body.activationId,
        launchManifestCommitment: body.launchManifestCommitment, resourceId: body.resourceId, agentTargetKey: body.agentTargetKey,
        protocol: body.protocol, modelId: body.modelId, initiator: body.initiator, target: body.target },
      credentialSelectionBinding, readiness }), checkLocalCurrentness });
    try {
      const response = await app.inject({ method: 'POST', url: '/readiness', payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.json().readiness).toEqual(readiness);
      expect(checkLocalCurrentness).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('rejects a substituted Home response before inspecting local source currentness', async () => {
    const authorize = vi.fn(async () => ({
      v: 1 as const,
      binding: {
        homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'other-resource', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses' as const, modelId: 'gpt-5',
        initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      },
      credentialSelectionBinding: { ...credentialSelectionBinding, resourceId: 'other-resource' },
      readiness: { kind: 'available' as const },
    }));
    const checkLocalCurrentness = vi.fn(async () => ({ kind: 'available' as const }));
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, { authorize, checkLocalCurrentness });
    const response = await app.inject({ method: 'POST', url: '/readiness', payload: {
      v: 1, kind: 'provider_broker_readiness', homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) }, activationSignature: 'A'.repeat(86), installationSignature: 'A'.repeat(86),
    } });
    expect(response.statusCode).toBe(403);
    expect(checkLocalCurrentness).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports unavailable Home verification as retryable without exposing failure details', async () => {
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, {
      authorize: vi.fn(async () => {
        throw new Error('private upstream detail');
      }),
    });
    const response = await app.inject({ method: 'POST', url: '/readiness', payload: {
      v: 1, kind: 'provider_broker_readiness', homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) }, activationSignature: 'A'.repeat(86), installationSignature: 'A'.repeat(86),
    } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ failureCause: { phase: 'runner.broker_readiness', errorClass: 'Error', errorCode: null, httpStatus: null } });
    expect(response.body).not.toContain('private upstream');
    await app.close();
  });

  it('keeps explicit Home authorization denial opaque', async () => {
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, {
      authorize: vi.fn(async () => {
        throw Object.assign(new Error('private denial detail'), {
          isAxiosError: true,
          response: { status: 403 },
        });
      }),
    });
    const response = await app.inject({ method: 'POST', url: '/readiness', payload: {
      v: 1, kind: 'provider_broker_readiness', homeServerIdentityId: 'srv_home', activationId: '00000000-0000-4000-8000-000000000010', launchManifestCommitment: 'A'.repeat(43), resourceId: 'resource-1', agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses', modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) }, target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) }, activationSignature: 'A'.repeat(86), installationSignature: 'A'.repeat(86),
    } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ failureCause: { phase: 'runner.broker_readiness', errorClass: 'Error', errorCode: null, httpStatus: 403 } });
    expect(response.body).not.toContain('private denial');
    await app.close();
  });

  it('rejects unknown fields before Home custody', async () => {
    const authorize = vi.fn();
    const app = fastify();
    registerRunnerBrokerReadinessApplication(app, { authorize });
    const response = await app.inject({ method: 'POST', url: '/readiness', payload: { prompt: 'never' } });
    expect(response.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
    await app.close();
  });
});
