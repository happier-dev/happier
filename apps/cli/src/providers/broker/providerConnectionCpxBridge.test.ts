import { readProviderBrokerResponseBody } from '@/providers/broker/providerBroker.testkit';
import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { ManagedServiceRequest, ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createProviderConnectionCpxBridge, projectProviderConnectionBrokerApplication, readProviderConnectionBrokerImplementation } from './providerConnectionCpxBridge';
import { ProviderContributionV1Schema } from '@happier-dev/plugin-sdk/providers';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/cliproxyapi/src/provider/contribution';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

function declaredBroker(pluginId: string, transport: boolean, localId = 'gateway'): ResolvedProviderContribution {
  const definition = ProviderContributionV1Schema.parse({
    ...CLIPROXYAPI_PROVIDER_CONTRIBUTION,
    id: localId,
    managedRuntime: {
      ...CLIPROXYAPI_PROVIDER_CONTRIBUTION.managedRuntime,
      ...(transport ? { sourceEnvelopeTransport: 'cpx-v1' } : { sourceEnvelopeTransport: undefined }),
    },
  });
  return { identity: { pluginId, localId: definition.id }, pluginId, definition,
    provenance: 'external', source: { kind: 'path' } };
}

const application = {
  agentTargetKey: 'agent:happier.agent.codex/codex',
  implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
  endpointTemplateId: 'cliproxyapi-openai-responses',
  protocol: 'openai-responses' as const,
};
const operation = { kind: 'session' as const, sessionId: 'session-a' };

function credentialLease(name = 'authorization', value = 'Bearer source-secret') {
  const redaction = createProviderRedactionLease({ values: ['source-secret', value] });
  return {
    credential: { kind: 'httpHeader' as const, name, value },
    redact: redaction.redact,
    containsSensitiveValue: redaction.containsSensitiveValue,
    createStreamingSanitizer: redaction.createStreamingSanitizer,
    close: redaction.close,
  };
}

function response(body = '{"echo":"source-secret"}', status = 200): ManagedServiceResponse {
  return Object.freeze({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unauthorized',
    headers: Object.freeze({ 'content-type': 'application/json', 'set-cookie': 'private=1' }),
    body: new Response(body).body,
  });
}

function custody(request: (input: ManagedServiceRequest) => Promise<ManagedServiceResponse>) {
  const cleanup = vi.fn();
  const acquire = vi.fn<ManagedProviderExplicitStartCustody['acquire']>(async () => Object.freeze({
    access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1', request }),
    isCurrent: () => true,
    cleanup,
  }));
  return {
    owner: Object.freeze({
      acquire,
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    }),
    acquire,
    cleanup,
  };
}

describe('Provider Connection CPX bridge', () => {
  it('admits the bundled producer through its declared private source transport', () => {
    const definition = ProviderContributionV1Schema.parse(CLIPROXYAPI_PROVIDER_CONTRIBUTION);
    const provider: ResolvedProviderContribution = {
      identity: application.implementationIdentity, pluginId: application.implementationIdentity.pluginId,
      definition, provenance: 'first_party', source: { kind: 'bundled' },
    };
    const registry = { providersByContributionKey: new Map([
      [`${provider.pluginId}/${provider.identity.localId}`, provider],
    ]) };
    expect(readProviderConnectionBrokerImplementation(registry)?.definition.managedRuntime?.sourceEnvelopeTransport).toBe('cpx-v1');
    expect(projectProviderConnectionBrokerApplication({ registry, agentTargetKey: application.agentTargetKey,
      protocol: application.protocol, expectedApplication: application })).toEqual(application);
  });

  it('admits an exact declared implementation without scanning unrelated Providers per request', () => {
    let enumerations = 0;
    class ProviderMap extends Map<string, ResolvedProviderContribution> {
      override values() {
        enumerations += 1;
        return super.values();
      }
    }
    const providers = new ProviderMap();
    for (let index = 0; index < 100; index += 1) {
      const provider = declaredBroker(`acme.broker-${index}`, true);
      providers.set(`${provider.pluginId}/${provider.identity.localId}`, provider);
    }
    const selected = providers.get('acme.broker-42/gateway')!;
    const registry = { providersByContributionKey: providers };
    const expectedApplication = { ...application, implementationIdentity: selected.identity };
    for (let request = 0; request < 100; request += 1) {
      expect(projectProviderConnectionBrokerApplication({ registry, agentTargetKey: application.agentTargetKey,
        protocol: application.protocol, expectedApplication })).toEqual(expectedApplication);
    }
    expect(enumerations).toBe(0);
    const undeclared = declaredBroker('acme.no-transport', false);
    providers.set(`${undeclared.pluginId}/${undeclared.identity.localId}`, undeclared);
    expect(projectProviderConnectionBrokerApplication({ registry, agentTargetKey: application.agentTargetKey,
      protocol: application.protocol, expectedApplication: { ...application, implementationIdentity: undeclared.identity } })).toBeNull();
  });

  it('selects an external declaration of the private source transport and refuses absent or ambiguous implementations', () => {
    const external = declaredBroker('acme.source-broker', true);
    const ordinary = declaredBroker('happier.provider.cliproxyapi', false, 'cliproxyapi');
    const registry = { providersByContributionKey: new Map([
      [`${ordinary.pluginId}/${ordinary.identity.localId}`, ordinary],
      [`${external.pluginId}/${external.identity.localId}`, external],
    ]) };
    expect(readProviderConnectionBrokerImplementation(registry)).toBe(external);
    expect(projectProviderConnectionBrokerApplication({ registry,
      agentTargetKey: application.agentTargetKey, protocol: application.protocol }))
      .toMatchObject({ implementationIdentity: external.identity });
    expect(readProviderConnectionBrokerImplementation({ providersByContributionKey: new Map([
      [`${ordinary.pluginId}/${ordinary.identity.localId}`, ordinary],
    ]) })).toBeNull();
    const second = declaredBroker('acme.other-broker', true);
    registry.providersByContributionKey.set(`${second.pluginId}/${second.identity.localId}`, second);
    expect(readProviderConnectionBrokerImplementation(registry)).toBeNull();
    expect(projectProviderConnectionBrokerApplication({ registry,
      agentTargetKey: application.agentTargetKey, protocol: application.protocol })).toBeNull();
  });

  it('uses operation-scoped managed custody and injects only a private exact-source envelope', async () => {
    const managedRequest = vi.fn<(input: ManagedServiceRequest) => Promise<ManagedServiceResponse>>(async () => response());
    const managed = custody(managedRequest);
    const bridge = createProviderConnectionCpxBridge({ custody: managed.owner });
    const projection = await bridge.open({
      application,
      operation,
      endpoint: {
        endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses', publicHeaders: { 'x-provider-client': 'happier' },
        resolvedAddresses: ['203.0.113.10'],
      },
      signal: new AbortController().signal,
      isCurrent: async () => true,
      acquireRequestCredential: async () => credentialLease(),
    });
    expect(projection?.access.endpointUrl(application.endpointTemplateId)).toBe('http://127.0.0.1:45123/v1');
    expect(managed.acquire).toHaveBeenCalledWith(expect.objectContaining({
      request: { reason: 'explicitStartLocal', endpointTemplateIds: [application.endpointTemplateId] },
      purposeBindings: { v: 1, bindings: [] },
      operationClaim: { kind: 'providerBroker', operation },
    }));
    await projection!.retire();
    await projection!.retire();
    expect(managed.owner.retire).toHaveBeenCalledOnce();
    expect(managed.owner.retire).toHaveBeenCalledWith({
      identity: application.implementationIdentity,
      operationClaim: { kind: 'providerBroker', operation },
    });
    const result = await projection!.access.request({
      pathAndQuery: '/v1/responses?stream=true', method: 'POST',
      headers: { authorization: 'Bearer worker', 'x-api-key': 'worker-key', 'x-client': 'worker' },
      body: new TextEncoder().encode('{}'),
    });
    const sent = managedRequest.mock.calls[0]![0];
    expect(sent.pathAndQuery).toBe('/v1/responses?stream=true');
    expect(sent.headers).toMatchObject({
      'x-client': 'worker',
      'x-happier-provider-source-credential': 'Bearer source-secret',
      'accept-encoding': 'identity',
    });
    expect(sent.headers).not.toHaveProperty('authorization');
    expect(sent.headers).not.toHaveProperty('x-api-key');
    const source = JSON.parse(Buffer.from(sent.headers!['x-happier-provider-source']!, 'base64url').toString('utf8'));
    expect(source).toEqual({
      baseUrl: 'https://gateway.example/v1', resolvedAddresses: ['203.0.113.10'],
      publicHeaders: { 'x-provider-client': 'happier' }, credentialHeaderName: 'authorization',
    });
    expect(result.headers).not.toHaveProperty('set-cookie');
    expect(await new Response(await readProviderBrokerResponseBody(result.body)).text()).toBe('{"echo":"[REDACTED]"}');
    expect(JSON.stringify({ projection, result })).not.toContain('gateway.example');
  });

  it('keeps the retained operation current after the creating caller goes away, and ends it only on retirement', async () => {
    const managed = custody(async () => response());
    const bridge = createProviderConnectionCpxBridge({ custody: managed.owner });
    const caller = new AbortController();
    let sourceCurrent = true;
    const projection = await bridge.open({
      application,
      operation,
      endpoint: {
        endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses', publicHeaders: {},
        resolvedAddresses: ['203.0.113.10'],
      },
      signal: caller.signal,
      isCurrent: async (signal = caller.signal) => !signal.aborted && sourceCurrent,
      acquireRequestCredential: async () => credentialLease(),
    });
    const retained = managed.acquire.mock.calls[0]![0];

    // The retained currentness belongs to the operation, which outlives the
    // stream that created it: closing that stream releases only this caller's
    // join, so a later stream on the same signed operation is still served.
    caller.abort();
    await projection!.cleanup();
    expect(retained.isAuthorizationCurrent()).toBe(true);
    await expect(retained.revalidateAuthorization()).resolves.toBe(false);
    expect(retained.isAuthorizationCurrent()).toBe(true);
    const operationRead = new AbortController();
    await expect(retained.revalidateAuthorization(operationRead.signal)).resolves.toBe(true);
    expect(managed.owner.retire).not.toHaveBeenCalled();

    // The operation's own authority still ends it.
    sourceCurrent = false;
    await expect(retained.revalidateAuthorization(operationRead.signal)).resolves.toBe(false);
    expect(retained.isAuthorizationCurrent()).toBe(false);
  });

  it('supports the Anthropic x-api-key variant and refuses caller/public header collisions', async () => {
    const managedRequest = vi.fn<(input: ManagedServiceRequest) => Promise<ManagedServiceResponse>>(async () => response('{"ok":true}'));
    const managed = custody(managedRequest);
    const bridge = createProviderConnectionCpxBridge({ custody: managed.owner });
    const projection = await bridge.open({
      application: { ...application, agentTargetKey: 'agent:happier.agent.claude/claude', endpointTemplateId: 'cliproxyapi-anthropic', protocol: 'anthropic' },
      operation,
      endpoint: {
        endpointTemplateId: 'messages', normalizedUrl: 'https://anthropic-gateway.example',
        protocol: 'anthropic', publicHeaders: { 'anthropic-version': '2023-06-01' },
        resolvedAddresses: ['2001:db8::10'],
      },
      signal: new AbortController().signal,
      isCurrent: async () => true,
      acquireRequestCredential: async () => credentialLease('x-api-key', 'source-key'),
    });
    await expect(projection!.access.request({
      pathAndQuery: '/v1/messages', headers: { 'anthropic-version': 'caller-value' },
    })).rejects.toMatchObject({ failure: { reasonCode: 'source_unavailable' } });
    await projection!.access.request({ pathAndQuery: '/v1/messages', method: 'POST' });
    const source = JSON.parse(Buffer.from(
      managedRequest.mock.calls[0]![0].headers!['x-happier-provider-source']!, 'base64url',
    ).toString('utf8'));
    expect(source.credentialHeaderName).toBe('x-api-key');
  });

  it('fails closed for source changes, protocol mismatch, and managed redirects', async () => {
    const managedRequest = vi.fn<(input: ManagedServiceRequest) => Promise<ManagedServiceResponse>>(async () => response('', 302));
    const managed = custody(managedRequest);
    const bridge = createProviderConnectionCpxBridge({ custody: managed.owner });
    let current = true;
    const open = (
      protocol: 'openai-responses' | 'openai-chat',
      isCurrent: () => Promise<boolean> = async () => current,
    ) => bridge.open({
      application,
      operation,
      endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1', protocol, publicHeaders: {}, resolvedAddresses: ['203.0.113.10'] },
      signal: new AbortController().signal,
      isCurrent,
      acquireRequestCredential: async () => credentialLease(),
    });
    await expect(open('openai-chat')).resolves.toBeNull();
    let currentnessReads = 0;
    await expect(open(
      'openai-responses',
      async () => ++currentnessReads === 1,
    )).resolves.toBeNull();
    expect(managed.owner.retire).toHaveBeenCalledOnce();
    expect(managed.cleanup).toHaveBeenCalledOnce();
    current = true;
    const projection = await open('openai-responses');
    await expect(projection!.access.request({ pathAndQuery: '/v1/responses' })).resolves.toMatchObject({ status: 502 });
    current = false;
    await expect(projection!.access.request({ pathAndQuery: '/v1/responses' })).rejects.toMatchObject({ failure: { reasonCode: 'source_unavailable' } });
  });

  it('redacts bodyless response headers before releasing the request credential', async () => {
    const close = vi.fn();
    const managed = custody(async () => Object.freeze({
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: Object.freeze({
        'x-benign': 'Bearer source-secret',
        'x-safe': 'safe',
      }),
      body: null,
    }));
    const bridge = createProviderConnectionCpxBridge({ custody: managed.owner });
    const projection = await bridge.open({
      application,
      operation,
      endpoint: {
        endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses', publicHeaders: {}, resolvedAddresses: ['203.0.113.10'],
      },
      signal: new AbortController().signal,
      isCurrent: async () => true,
      acquireRequestCredential: async () => {
        const lease = credentialLease();
        return { ...lease, close: () => { lease.close(); close(); } };
      },
    });
    const result = await projection!.access.request({ pathAndQuery: '/v1/responses' });
    expect(result.headers).toEqual({ 'x-safe': 'safe' });
    expect(result.body).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it('retries one replayable request only after the current Saved Secret changes', async () => {
    const managedRequest = vi.fn<(input: ManagedServiceRequest) => Promise<ManagedServiceResponse>>(
      async (): Promise<ManagedServiceResponse> => (
        managedRequest.mock.calls.length === 1 ? response('', 401) : response('{"ok":true}')
      ),
    );
    const managed = custody(managedRequest);
    const bridge = createProviderConnectionCpxBridge({ custody: managed.owner });
    let acquisition = 0;
    const projection = await bridge.open({
      application,
      operation,
      endpoint: { endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1', protocol: 'openai-responses', publicHeaders: {}, resolvedAddresses: ['203.0.113.10'] },
      signal: new AbortController().signal,
      isCurrent: async () => true,
      acquireRequestCredential: async () => {
        acquisition += 1;
        return credentialLease('authorization', acquisition === 1 ? 'Bearer old-secret' : 'Bearer rotated-secret');
      },
    });
    await expect(projection!.access.request({
      pathAndQuery: '/v1/responses', method: 'POST', body: new TextEncoder().encode('{}'),
    })).resolves.toMatchObject({ status: 200 });
    expect(managedRequest).toHaveBeenCalledTimes(2);
    expect(managedRequest.mock.calls[0]![0].headers?.['x-happier-provider-source-credential']).toBe('Bearer old-secret');
    expect(managedRequest.mock.calls[1]![0].headers?.['x-happier-provider-source-credential']).toBe('Bearer rotated-secret');
  });
});
