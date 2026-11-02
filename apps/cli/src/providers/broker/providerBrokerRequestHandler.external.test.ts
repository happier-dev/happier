import { readProviderBrokerResponseBody } from '@/providers/broker/providerBroker.testkit';
import { describe, expect, it, vi } from 'vitest';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import type { ManagedProviderEndpointHttpAccess } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createProviderBrokerRequestHandler } from './providerBrokerRequestHandler';
import { teamCredentialBrokerResourceAcceptsMachine } from './teamCredentialBrokerSourceOwner';

const binding = {
  v: 1 as const,
  kind: 'external_api_key' as const,
  teamId: 'team-1', resourceId: 'resource-1', requestId: 'request-1',
  externalApiKeyId: '550e8400-e29b-41d4-a716-446655440000',
  operationId: '550e8400-e29b-41d4-a716-446655440001',
  brokerPlacementFingerprint: 'c'.repeat(64),
  assignedAccountId: 'account-1', assignedTeamMembershipId: 'membership-1',
};
const externalRequest = {
  v: 1 as const,
  requestId: binding.requestId, teamId: binding.teamId, resourceId: binding.resourceId,
  caller: {
    kind: 'external_api_key' as const, keyId: binding.externalApiKeyId,
    assignedAccountId: binding.assignedAccountId,
    assignedTeamMembershipId: binding.assignedTeamMembershipId,
  },
  route: 'responses' as const, method: 'POST' as const, pathAndQuery: '/v1/responses',
  headers: { authorization: 'Bearer must-not-cross', 'content-type': 'application/json' },
  bodyBase64: null,
};

describe('Provider broker external authenticated context', () => {
  it('accepts an admitted Pool target and converges on the same model policy and managed request owner', async () => {
    const recordTerminal = vi.fn(async () => {});
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => 'http://127.0.0.1:1234',
      request: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null })),
    };
    const admitExternal = vi.fn(async () => ({
      ok: true as const,
      access,
      terminalUsage: { record: recordTerminal },
    }));
    const poolResource = {
      enabled: true,
      teamId: binding.teamId,
      brokerPlacement: { kind: 'machine_pool' as const, poolId: 'pool-1' },
      source: TeamCredentialSourceBindingV1Schema.parse({
        v: 1 as const,
        kind: 'provider_connection' as const,
        connectionId: 'provider-connection-1',
        connectionSecurityFingerprint: 'connection-security:v1:test',
        credentialSlotId: 'apiKey',
      }),
    };
    const receiverAcceptsResource = () => teamCredentialBrokerResourceAcceptsMachine(poolResource, 'broker-machine')
      && poolResource.teamId === binding.teamId;
    expect(receiverAcceptsResource()).toBe(true);
    expect(teamCredentialBrokerResourceAcceptsMachine(
      { ...poolResource, brokerPlacement: { kind: 'machine', machineId: 'broker-machine' } }, 'broker-machine',
    )).toBe(true);
    expect(teamCredentialBrokerResourceAcceptsMachine(
      { ...poolResource, brokerPlacement: { kind: 'machine', machineId: 'other-machine' } }, 'broker-machine',
    )).toBe(false);
    expect(teamCredentialBrokerResourceAcceptsMachine(
      { ...poolResource, enabled: false }, 'broker-machine',
    )).toBe(false);

    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => receiverAcceptsResource()
        ? {
            kind: 'application' as const,
            resourceRevision: 4,
            policy: null,
            modelCatalog: {
              models: [{ id: 'gpt-5' }],
              resolveCanonicalModelId: (id: string) => id,
            },
            application: {
              agentTargetKey: 'agent:happier.agent.codex/codex',
              implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
              endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const,
            },
          }
        : null,
      admitExternal,
    });
    const body = new TextEncoder().encode('{"model":"gpt-5","input":"hello"}');
    await expect(handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, bodyBase64: 'e30=' },
      request: { pathAndQuery: '/v1/responses', method: 'POST', headers: externalRequest.headers, body },
    })).resolves.toMatchObject({ ok: true });
    expect(admitExternal).toHaveBeenCalledWith(expect.objectContaining({
      binding,
      expectedResourceRevision: 4,
      request: expect.objectContaining({ headers: { 'content-type': 'application/json' } }),
    }));
    expect(access.request).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'content-type': 'application/json' } }));
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({ outcome: 'failed', actualModelId: null, tokens: null });
  });

  it.each([
    { name: 'provider error', responseOk: false, cancel: false, outcome: 'failed' as const },
    { name: 'caller cancellation', responseOk: true, cancel: true, outcome: 'cancelled' as const },
  ])('records one unavailable terminal fact after $name', async ({ responseOk, cancel, outcome }) => {
    const recordTerminal = vi.fn(async () => {});
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
        if (!cancel) controller.close();
      },
    });
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => 'http://127.0.0.1:1234',
      request: vi.fn(async () => ({
        ok: responseOk,
        status: responseOk ? 200 : 429,
        statusText: responseOk ? 'OK' : 'Provider error',
        headers: {},
        body,
      })),
    };
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 4,
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (id) => id },
        application: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
        },
      }),
      admitExternal: async () => ({
        ok: true as const,
        access,
        terminalUsage: { record: recordTerminal },
      }),
    });
    const result = await handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, bodyBase64: 'e30=' },
      request: {
        pathAndQuery: '/v1/responses', method: 'POST',
        body: new TextEncoder().encode('{"model":"gpt-5","input":"hello"}'),
      },
    });
    if (!result.ok || !result.response.body) throw new Error('expected streamed Provider response');
    const reader = result.response.body.getReader();
    await reader.read();
    if (cancel) await reader.cancel();
    else await reader.read();
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({ outcome, actualModelId: null, tokens: null });
  });

  it('reports the streamed Provider terminal token fact of the admitted external request', async () => {
    const recordTerminal = vi.fn(async () => {});
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5-2025-11-01"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"he"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5-2025-11-01",'
        + '"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":80},'
        + '"output_tokens":45,"output_tokens_details":{"reasoning_tokens":30},"total_tokens":165}}}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split across chunk boundaries so the observer cannot depend on one
        // SSE event arriving as one transport chunk.
        const encoded = new TextEncoder().encode(sse.join(''));
        controller.enqueue(encoded.slice(0, 90));
        controller.enqueue(encoded.slice(90));
        controller.close();
      },
    });
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => 'http://127.0.0.1:1234',
      request: vi.fn(async () => ({
        ok: true, status: 200, statusText: 'OK',
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      })),
    };
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 4,
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (id) => id },
        application: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
        },
      }),
      admitExternal: async () => ({ ok: true as const, access, terminalUsage: { record: recordTerminal } }),
    });
    const result = await handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, bodyBase64: 'e30=' },
      request: {
        pathAndQuery: '/v1/responses', method: 'POST',
        body: new TextEncoder().encode('{"model":"gpt-5","input":"hello","stream":true}'),
      },
    });
    if (!result.ok || !result.response.body) throw new Error('expected streamed Provider response');
    const reader = result.response.body.getReader();
    const seen: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      seen.push(new TextDecoder().decode(next.value));
    }
    // The caller still receives the Provider's exact bytes.
    expect(seen.join('')).toBe(sse.join(''));
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({
      outcome: 'succeeded',
      actualModelId: 'gpt-5-2025-11-01',
      tokens: { input: 120, output: 45, reasoning: 30, cacheRead: 80, cacheWrite: 0, total: 165 },
    });
  });

  it.each([
    {
      name: 'in-band error',
      ending: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      expected: { outcome: 'failed', actualModelId: null, tokens: null },
    },
    {
      name: 'premature EOF', ending: '',
      expected: { outcome: 'failed', actualModelId: null, tokens: null },
    },
    {
      name: 'completed message without final usage',
      ending: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      expected: { outcome: 'succeeded', actualModelId: 'claude-sonnet-4-6', tokens: null },
    },
    {
      name: 'completed message with final usage',
      ending: 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      expected: {
        outcome: 'succeeded', actualModelId: 'claude-sonnet-4-6',
        tokens: { input: 25, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 32 },
      },
    },
  ])('preserves Anthropic bytes and truthful usage after $name', async ({ ending, expected }) => {
    const terminalFacts: unknown[] = [];
    let admissionCount = 0;
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
      + '"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1}}}\n\n' + ending;
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 4,
        policy: null,
        modelCatalog: { models: [{ id: 'claude-sonnet-4-6' }], resolveCanonicalModelId: (id) => id },
        application: {
          agentTargetKey: 'agent:happier.agent.claude/claude',
          implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          endpointTemplateId: 'cliproxyapi-anthropic', protocol: 'anthropic',
        },
      }),
      // Home admission and the managed HTTP response are the system boundaries;
      // the real request-policy and terminal observation owners run beneath them.
      admitExternal: async () => {
        admissionCount += 1;
        return {
          ok: true as const,
          access: {
            endpointUrl: () => 'http://127.0.0.1:1234',
            request: async () => ({
              ok: true, status: 200, statusText: 'OK',
              headers: { 'content-type': 'text/event-stream' },
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(sse));
                  controller.close();
                },
              }),
            }),
          },
          terminalUsage: { record: async (fact) => { terminalFacts.push(fact); } },
        };
      },
    });
    const result = await handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, route: 'messages', pathAndQuery: '/v1/messages', bodyBase64: 'e30=' },
      request: {
        pathAndQuery: '/v1/messages', method: 'POST',
        body: new TextEncoder().encode('{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[],"stream":true}'),
      },
    });
    if (!result.ok) throw new Error('expected admitted Provider response');
    expect(await new Response(await readProviderBrokerResponseBody(result.response.body)).text()).toBe(sse);
    expect(admissionCount).toBe(1);
    expect(terminalFacts).toEqual([expected]);
  });

  it('records one failed terminal fact when the admitted Provider response is lost', async () => {
    const recordTerminal = vi.fn(async () => {});
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 4,
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (id) => id },
        application: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
        },
      }),
      admitExternal: async () => ({
        ok: true as const,
        access: {
          endpointUrl: () => 'http://127.0.0.1:1234',
          request: async () => { throw new Error('response lost'); },
        },
        terminalUsage: { record: recordTerminal },
      }),
    });
    await expect(handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, bodyBase64: 'e30=' },
      request: {
        pathAndQuery: '/v1/responses', method: 'POST',
        body: new TextEncoder().encode('{"model":"gpt-5","input":"hello"}'),
      },
    })).rejects.toThrow('response lost');
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({ outcome: 'failed', actualModelId: null, tokens: null });
  });

  it('records one failed terminal fact when the Provider stream truncates', async () => {
    const recordTerminal = vi.fn(async () => {});
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 4,
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (id) => id },
        application: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
        },
      }),
      admitExternal: async () => ({
        ok: true as const,
        access: {
          endpointUrl: () => 'http://127.0.0.1:1234',
          request: async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: {},
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'));
                controller.error(new Error('truncated'));
              },
            }),
          }),
        },
        terminalUsage: { record: recordTerminal },
      }),
    });
    const result = await handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, bodyBase64: 'e30=' },
      request: {
        pathAndQuery: '/v1/responses', method: 'POST',
        body: new TextEncoder().encode('{"model":"gpt-5","input":"hello"}'),
      },
    });
    if (!result.ok || !result.response.body) throw new Error('expected streamed Provider response');
    const reader = result.response.body.getReader();
    await expect(reader.read()).rejects.toThrow('truncated');
    expect(recordTerminal).toHaveBeenCalledOnce();
    expect(recordTerminal).toHaveBeenCalledWith({ outcome: 'failed', actualModelId: null, tokens: null });
  });

  it('authorizes every exact current application before returning the protocol-neutral model union', async () => {
    const responses = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const,
    };
    const chat = {
      ...responses,
      endpointTemplateId: 'cliproxyapi-openai-chat', protocol: 'openai-chat' as const,
    };
    const authorizeModelCatalog = vi.fn<NonNullable<
      Parameters<typeof createProviderBrokerRequestHandler>[0]['authorizeModelCatalog']
    >>(async () => ({ ok: true as const }));
    const admitExternal = vi.fn();
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'model_catalog' as const,
        resourceRevision: 4,
        policy: null,
        applications: [responses, chat],
        modelCatalog: {
          models: [{ id: 'shared-model' }],
          resolveCanonicalModelId: (id) => id,
        },
      }),
      authorizeModelCatalog,
      admitExternal,
    });

    const result = await handler({
      context: { kind: 'external', binding },
      carrierRequest: {
        ...externalRequest,
        route: 'models', method: 'GET', pathAndQuery: '/v1/models', bodyBase64: null,
      },
      request: { pathAndQuery: '/v1/models', method: 'GET' },
    });

    expect(result).toMatchObject({ ok: true, response: { status: 200 } });
    expect(authorizeModelCatalog).toHaveBeenCalledTimes(2);
    expect(authorizeModelCatalog.mock.calls.map(([call]) => {
      // The external API key relay must authorize through its own arm; the private
      // signed-grant arm carries no per-application binding here.
      if (call.authorization.kind !== 'external_api_key') {
        throw new Error(`expected an external API key authorization, received ${call.authorization.kind}`);
      }
      return call.authorization.application;
    })).toEqual([responses, chat]);
    expect(admitExternal).not.toHaveBeenCalled();
  });

  it('admits Anthropic token-count Provider data without attaching generation terminal usage', async () => {
    const anthropicApplication = {
      agentTargetKey: 'agent:happier.agent.claude/claude',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-anthropic',
      protocol: 'anthropic' as const,
    };
    const admitExternal = vi.fn(async () => ({
      ok: true as const,
      access: {
        endpointUrl: () => 'http://127.0.0.1:1234',
        request: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null })),
      } satisfies ManagedProviderEndpointHttpAccess,
    }));
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 4,
        policy: null,
        application: anthropicApplication,
        modelCatalog: {
          models: [{ id: 'claude' }],
          resolveCanonicalModelId: (id) => id,
        },
      }),
      admitExternal,
    });

    const result = await handler({
      context: { kind: 'external', binding },
      carrierRequest: {
        ...externalRequest,
        route: 'messages_count_tokens',
        method: 'POST',
        pathAndQuery: '/v1/messages/count_tokens',
        bodyBase64: 'eyJtb2RlbCI6ImNsYXVkZSJ9',
      },
      request: {
        pathAndQuery: '/v1/messages/count_tokens',
        method: 'POST',
        body: new TextEncoder().encode('{"model":"claude"}'),
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(admitExternal).toHaveBeenCalledWith(expect.objectContaining({
      requestFacts: expect.objectContaining({ generation: false, routeKind: 'anthropic_messages', modelId: 'claude' }),
    }));
  });

  it('rejects attribution changed after relay authorization', async () => {
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [], nowMs: Date.now,
      resolveRequestPolicy: vi.fn(), admit: vi.fn(), createRequestId: () => 'unused',
      resolveExternalRequestPolicy: vi.fn(), admitExternal: vi.fn(),
    });
    await expect(handler({
      context: { kind: 'external', binding },
      carrierRequest: { ...externalRequest, requestId: 'other', bodyBase64: 'e30=' },
      request: { pathAndQuery: '/v1/responses', method: 'POST', body: new TextEncoder().encode('{}') },
    })).resolves.toEqual({ ok: false, reasonCode: 'transport_identity_mismatch' });
  });
});
