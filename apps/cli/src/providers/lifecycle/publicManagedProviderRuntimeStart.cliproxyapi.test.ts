import { describe, expect, it, vi } from 'vitest';

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

function healthyIdentityFor(boundPurposes: readonly ManagedPurpose[]) {
  const families = [
    boundPurposes.includes('openai-upstream')
      ? Object.freeze({
          purpose: 'openai-upstream',
          protocols: Object.freeze(['openai-chat', 'openai-responses']),
        })
      : null,
    boundPurposes.includes('anthropic-upstream')
      ? Object.freeze({
          purpose: 'anthropic-upstream',
          protocols: Object.freeze(['anthropic']),
        })
      : null,
  ].filter((family): family is NonNullable<typeof family> => family !== null);
  return Object.freeze({
    v: 1,
    contractVersion: 'happier.cliproxyapi-managed/v1',
    sdkVersion: 'v7.2.95',
    wrapperBuildVersion: 'cliproxyapi-test-build',
    protocols: families.flatMap((family) => family.protocols),
    purposes: families.map((family) => Object.freeze({
      consumer: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      purpose: family.purpose,
    })),
    modelListEnabled: true,
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
      activationGeneration: 'activation-cliproxyapi',
      immutableGenerationId: 'immutable-cliproxyapi',
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

  it('projects only the exact bound OpenAI family before endpoint publication', async () => {
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
      activationGeneration: 'activation-cliproxyapi',
      immutableGenerationId: 'immutable-cliproxyapi',
      isCurrent: () => true,
    }) satisfies ResolvedManagedProviderRuntime;
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ kind: 'opaque-endpoint-access' as const }),
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
      ],
    }));

    await launchResourceScope.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('fails typed before child supervision or endpoint publication when every purpose is unbound', async () => {
    const supervise = vi.fn<ManagedServices['supervise']>();
    const projectEndpointAccess = vi.fn();
    const runtime = await captureCliProxyApiRuntime();
    const resolved = Object.freeze({
      runtime,
      activationGeneration: 'activation-cliproxyapi',
      immutableGenerationId: 'immutable-cliproxyapi',
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
