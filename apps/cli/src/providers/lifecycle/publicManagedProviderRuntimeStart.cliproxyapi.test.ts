import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { openAccountConnectionProviderBrokerAccess } from '@/providers/broker/accountConnectionClient';
import { createProviderBrokerRequestHandler } from '@/providers/broker/providerBrokerRequestHandler';
import type { PublicManagedProviderEndpointPath } from './publicManagedProviderRuntimeStart';

import type {
  ConnectedAccountBindingSummary,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  activate as activateCliProxyApi,
  PLUGIN_MANIFEST as CLIPROXYAPI_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-cliproxyapi';

import type { ResolvedManagedProviderRuntime } from '@/plugins/projection/registry/types';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';

import { createProviderLaunchResourceScope } from './resourceScope';
import { startPublicManagedProviderRuntime } from './publicManagedProviderRuntimeStart';

const healthySnapshot = Object.freeze({
  id: 'cliproxyapi-managed',
  state: 'healthy',
  mode: 'spawn',
  baseUrl: 'http://127.0.0.1:45123',
  startedAtMs: 1,
  lastHealthyAtMs: 2,
  diagnostics: Object.freeze([]),
  diagnosticsTruncated: false,
} satisfies ManagedServiceSnapshot);

async function captureCliProxyApiRuntime(): Promise<ManagedProviderRuntime> {
  const activation = await createPluginTestkit({
    manifest: CLIPROXYAPI_PLUGIN_MANIFEST,
    module: { activate: activateCliProxyApi },
  });
  const registered = activation.registration('providers', 'cliproxyapi');
  await activation.dispose();
  const runtime = registered?.managedRuntime;
  if (!runtime) throw new Error('CLIProxyAPI managed runtime was not registered');
  return runtime;
}

type ManagedPurpose = 'openai-upstream' | 'anthropic-upstream';

function bindingFor(purpose: ManagedPurpose): ConnectedAccountBindingSummary {
  const service = purpose === 'openai-upstream'
    ? Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      })
    : Object.freeze({
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      });
  return Object.freeze({
    purpose,
    service,
    account: Object.freeze({
      service,
      accountId: `${purpose}-account`,
    }),
    target: Object.freeze({ kind: 'account' as const, displayName: purpose }),
  });
}

function connectedAccounts(
  boundPurposes: readonly ManagedPurpose[] = [
    'openai-upstream',
    'anthropic-upstream',
  ],
): ConnectedAccountsService {
  const bound = new Set(boundPurposes);
  return Object.freeze({
    async getBinding(purpose: string) {
      if (purpose !== 'openai-upstream' && purpose !== 'anthropic-upstream') {
        return null;
      }
      return bound.has(purpose) ? bindingFor(purpose) : null;
    },
    async requestSelection() {
      throw new Error('selection is unavailable during managed start');
    },
    async materialize() {
      throw new Error('materialization is unavailable during managed start');
    },
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch() { return Object.freeze({ dispose() {} }); },
  });
}

function healthyIdentityFor(_boundPurposes: readonly ManagedPurpose[]) {
  const families = [
    Object.freeze({
          purpose: 'openai-upstream',
          protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
        }),
    Object.freeze({
          purpose: 'anthropic-upstream',
          protocols: Object.freeze(['openai-chat', 'openai-responses', 'anthropic']),
        }),
  ];
  return Object.freeze({
    v: 1,
    contractVersion: 'happier.cliproxyapi-managed/v2',
    sdkVersion: 'v7.2.95',
    wrapperBuildVersion: 'cliproxyapi-test-build',
    protocols: [...new Set(families.flatMap((family) => family.protocols))],
    purposes: families.map((family) => Object.freeze({
      consumer: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      purpose: family.purpose,
    })),
    modelListEnabled: true,
    sourceClass: 'connected_account',
  });
}

describe('CLIProxyAPI composed public managed Provider start', () => {
  it('does not project endpoint access when the live wrapper identity is incompatible', async () => {
    const dispose = vi.fn(async () => undefined);
    const request = vi.fn<ManagedServiceHandle['request']>(async () => Object.freeze({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new Response(JSON.stringify({ status: 'ok' })).body,
    }) satisfies ManagedServiceResponse);
    const service = Object.freeze({
      snapshot: () => healthySnapshot,
      observe: vi.fn(() => Object.freeze({ dispose() {} })),
      waitUntilHealthy: vi.fn(async () => healthySnapshot),
      request,
      stop: vi.fn(async () => Object.freeze({ status: 'stopped' as const })),
      dispose,
    }) satisfies ManagedServiceHandle;
    const supervise = vi.fn<ManagedServices['supervise']>(async () => service);
    const runtime = await captureCliProxyApiRuntime();
    const resolved = Object.freeze({
      runtime,
      activationOccurrenceId: 'activation-cliproxyapi',
      sourceCustody: createManagedPluginSourceCustody('immutable-cliproxyapi'),
      isCurrent: () => true,
    }) satisfies ResolvedManagedProviderRuntime;
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze([
          'cliproxyapi-openai-responses',
          'cliproxyapi-openai-chat',
          'cliproxyapi-anthropic',
        ]),
      }),
      acquireRuntime: async () => resolved,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: Object.freeze({
          dependencies: Object.freeze({}) as never,
          supervise,
        }),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_failed' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      pathAndQuery: '/healthz',
      method: 'GET',
      signal: expect.any(AbortSignal),
    }));
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('projects proven downstream endpoints for the bound OpenAI upstream before endpoint publication', async () => {
    const boundPurposes = ['openai-upstream'] as const;
    const dispose = vi.fn(async () => undefined);
    const request = vi.fn<ManagedServiceHandle['request']>(async () => Object.freeze({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new Response(JSON.stringify(healthyIdentityFor(boundPurposes))).body,
    }) satisfies ManagedServiceResponse);
    const service = Object.freeze({
      snapshot: () => healthySnapshot,
      observe: vi.fn(() => Object.freeze({ dispose() {} })),
      waitUntilHealthy: vi.fn(async () => healthySnapshot),
      request,
      stop: vi.fn(async () => Object.freeze({ status: 'stopped' as const })),
      dispose,
    }) satisfies ManagedServiceHandle;
    const supervise = vi.fn<ManagedServices['supervise']>(async () => service);
    const runtime = await captureCliProxyApiRuntime();
    const resolved = Object.freeze({
      runtime,
      activationOccurrenceId: 'activation-cliproxyapi',
      sourceCustody: createManagedPluginSourceCustody('immutable-cliproxyapi'),
      isCurrent: () => true,
    }) satisfies ResolvedManagedProviderRuntime;
    const projectEndpointAccess = vi.fn(async ({ endpoints }: Readonly<{ endpoints: readonly PublicManagedProviderEndpointPath[] }>) => Object.freeze({
      access: endpoints,
      isCurrent: () => true,
    }));
    const launchResourceScope = createProviderLaunchResourceScope();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze([
          'cliproxyapi-openai-responses',
          'cliproxyapi-openai-chat',
          'cliproxyapi-anthropic',
        ]),
      }),
      acquireRuntime: async () => resolved,
      connectedAccounts: connectedAccounts(boundPurposes),
      custody: Object.freeze({
        managedServices: Object.freeze({
          dependencies: Object.freeze({}) as never,
          supervise,
        }),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope,
    });

    expect(result).toMatchObject({
      ok: true,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(projectEndpointAccess).toHaveBeenCalledWith(expect.objectContaining({
      endpoints: [
        { endpointTemplateId: 'cliproxyapi-openai-responses', servicePath: '/v1' },
        { endpointTemplateId: 'cliproxyapi-openai-chat', servicePath: '/v1' },
        { endpointTemplateId: 'cliproxyapi-anthropic', servicePath: '/' },
      ],
    }));

    if (!result.ok) throw new Error('managed endpoint publication failed');
    // The process and carrier are boundaries. Runtime declaration, source
    // metadata, broker publication and installed SDK URL joining stay real.
    for (const endpoint of result.access) {
      const protocol = endpoint.endpointTemplateId === 'cliproxyapi-anthropic' ? 'anthropic'
        : endpoint.endpointTemplateId === 'cliproxyapi-openai-responses' ? 'openai-responses' : 'openai-chat';
      const application = { agentTargetKey: 'backend:claude:built_in',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: endpoint.endpointTemplateId, protocol } as const;
      const connectionId = ProviderConnectionIdSchema.parse('gateway-1');
      const consumer = { kind: 'session', sessionId: 'session-1' } as const;
      const source = { kind: 'account_connection', connectionId,
        expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
        expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' } as const;
      const opened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = {
        ok: true, authority: { payload: { v: 2, grantId: 'grant-1', aud: 'happier-provider-broker-route-v2',
          issuedAt: 100, expiresAt: 200, homeId: 'home-1', accountId: 'account-1', source,
          initiatorTokenEpoch: 0, initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
          target: { custodianAccountId: 'account-1', machineId: 'hub-1', endpointId: 'b'.repeat(64) }, consumer, application },
          signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.alloc(64).toString('base64url') } },
        target: { custodianAccountId: 'account-1', brokerMachineId: 'hub-1', endpointId: 'b'.repeat(64), endpointRevision: 1,
          endpoint: { endpointId: 'b'.repeat(64) } },
      };
      const upstream = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null }));
      let current = true;
      const handler = createProviderBrokerRequestHandler({ resolveTrustRoots: () => [], nowMs: () => 150,
        resolveRequestPolicy: async () => null, createRequestId: () => 'unused',
        admit: async () => ({ ok: false, reasonCode: 'resource_unavailable' }) });
      const context = { kind: 'account_connection' as const, authority: opened.authority,
        authenticatedRemoteEndpointId: opened.authority.payload.initiator.endpointId,
        access: { endpointUrl: (id: string) => id === endpoint.endpointTemplateId
          ? `http://127.0.0.1:45123${endpoint.servicePath}` : null, request: upstream },
        revalidate: async () => current, streamLifetime: { close: async () => {}, retire: async () => {} } };
      const access = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer, application,
        expectedConnectionSecurityFingerprint: source.expectedConnectionSecurityFingerprint,
        expectedManagedRuntimeBindingFingerprint: source.expectedManagedRuntimeBindingFingerprint,
        signal: new AbortController().signal, openBroker: async () => opened,
        admitConsumer: async () => current,
        openTunnel: async () => ({ localPort: 45124, localCapability: 'c'.repeat(64), observedPath: 'relay',
          retire: async () => {}, close: async () => {} }),
        fetchImpl: async (url, init) => {
          const response = await handler({ context, request: { method: 'GET', pathAndQuery: new URL(String(url)).pathname,
            signal: init?.signal ?? undefined } });
          return response.ok ? new Response(response.response.body, { status: response.response.status, headers: response.response.headers })
            : new Response(null, { status: 403 });
        },
      });
      try {
        const binding = await access.readHttpBinding();
        expect(new URL(binding.endpointUrl).pathname).toBe(endpoint.servicePath);
        let requestedPath = '';
        const sdkFetch: typeof fetch = async (url) => {
          requestedPath = new URL(url instanceof Request ? url.url : String(url)).pathname;
          return Response.json({ id: 'result', type: 'message', role: 'assistant', content: [], model: 'test',
            object: 'response', output: [], choices: [], usage: { input_tokens: 0, output_tokens: 0 } });
        };
        if (protocol === 'anthropic') {
          await new Anthropic({ apiKey: 'test', baseURL: binding.endpointUrl, fetch: sdkFetch, maxRetries: 0 })
            .messages.create({ model: 'test', max_tokens: 1, messages: [] });
        } else {
          const client = new OpenAI({ apiKey: 'test', baseURL: binding.endpointUrl, fetch: sdkFetch, maxRetries: 0 });
          if (protocol === 'openai-responses') await client.responses.create({ model: 'test', input: 'test' });
          else await client.chat.completions.create({ model: 'test', messages: [] });
        }
        expect(requestedPath).toBe(protocol === 'anthropic' ? '/v1/messages'
          : protocol === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions');
        expect(upstream).not.toHaveBeenCalled();
        current = false;
        await expect(access.readHttpBinding()).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      } finally { await access.cleanup(); }
    }

    await launchResourceScope.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('fails typed before child supervision or endpoint publication when every purpose is unbound', async () => {
    const supervise = vi.fn<ManagedServices['supervise']>();
    const projectEndpointAccess = vi.fn();
    const runtime = await captureCliProxyApiRuntime();
    const resolved = Object.freeze({
      runtime,
      activationOccurrenceId: 'activation-cliproxyapi',
      sourceCustody: createManagedPluginSourceCustody('immutable-cliproxyapi'),
      isCurrent: () => true,
    }) satisfies ResolvedManagedProviderRuntime;

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze([
          'cliproxyapi-openai-responses',
          'cliproxyapi-openai-chat',
          'cliproxyapi-anthropic',
        ]),
      }),
      acquireRuntime: async () => resolved,
      connectedAccounts: connectedAccounts([]),
      custody: Object.freeze({
        managedServices: Object.freeze({
          dependencies: Object.freeze({}) as never,
          supervise,
        }),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_failed' });
    expect(supervise).not.toHaveBeenCalled();
    expect(projectEndpointAccess).not.toHaveBeenCalled();
  });
});
