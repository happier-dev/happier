import { describe, expect, it, vi } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountsService,
  PluginConnectedAccountBindingSummary,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderRuntime,
  ManagedProviderStartRequest } from '@happier-dev/plugin-sdk/providers';
import { ProviderConnectionIdSchema } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServiceResponse,
  ManagedServiceSnapshot,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';

import { activate } from './index.js';
import * as publicPackage from './index.js';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

type ManagedPurpose = 'openai-upstream' | 'anthropic-upstream';

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

const healthyIdentity = Object.freeze({
  v: 1,
  contractVersion: 'happier.cliproxyapi-managed/v1',
  sdkVersion: 'v7.2.95',
  wrapperBuildVersion: 'cliproxyapi-test-build',
  protocols: Object.freeze([
    'openai-chat',
    'openai-responses',
    'anthropic',
  ]),
  purposes: Object.freeze([
    Object.freeze({
      consumer: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      purpose: 'openai-upstream',
    }),
    Object.freeze({
      consumer: Object.freeze({
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      }),
      purpose: 'anthropic-upstream',
    }),
  ]),
  modelListEnabled: true,
});

const anthropicOnlyIdentity = Object.freeze({
  ...healthyIdentity,
  protocols: Object.freeze(['anthropic']),
  purposes: Object.freeze([healthyIdentity.purposes[1]!]),
});

const fullyBoundPurposeConfiguration = JSON.stringify({
  v: 2,
  purposes: [
    {
      id: 'codex',
      provider: 'codex',
      consumer: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      purpose: 'openai-upstream',
      allowedHttpsOrigin: 'https://chatgpt.com',
      protocols: ['openai-chat', 'openai-responses'],
    },
    {
      id: 'claude',
      provider: 'claude',
      consumer: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      purpose: 'anthropic-upstream',
      allowedHttpsOrigin: 'https://api.anthropic.com',
      protocols: ['anthropic'],
    },
  ],
});

const anthropicOnlyPurposeConfiguration = JSON.stringify({
  v: 2,
  purposes: [{
    id: 'claude',
    provider: 'claude',
    consumer: {
      pluginId: 'happier.provider.cliproxyapi',
      localId: 'cliproxyapi',
    },
    purpose: 'anthropic-upstream',
    allowedHttpsOrigin: 'https://api.anthropic.com',
    protocols: ['anthropic'],
  }],
});

function response(
  body: string | Uint8Array,
  options: Readonly<{
    status?: number;
    contentType?: string;
  }> = {},
): ManagedServiceResponse {
  const status = options.status ?? 200;
  return Object.freeze({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Service Unavailable',
    headers: Object.freeze({
      'content-type': options.contentType ?? 'application/json; charset=utf-8',
    }),
    body: new Response(body).body,
  });
}

const healthyIdentityResponse = (): ManagedServiceResponse => response(
  JSON.stringify(healthyIdentity),
);

function boundAccount(purpose: ManagedPurpose): PluginConnectedAccountBindingSummary {
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
  boundPurposes: readonly ManagedPurpose[],
): ConnectedAccountsService {
  const bound = new Set(boundPurposes);
  return Object.freeze({
    async getBinding(purpose) {
      if (purpose !== 'openai-upstream' && purpose !== 'anthropic-upstream') {
        return null;
      }
      return bound.has(purpose) ? boundAccount(purpose) : null;
    },
    async requestSelection() {
      throw new Error('selection is unavailable during managed start');
    },
    async materialize() {
      throw new Error('materialization is unavailable during managed start');
    },
    async listAccounts() {
      throw new Error('account listing is unavailable during managed start');
    },
    async materializeListedAccount() {
      throw new Error('exact-listed materialization is unavailable during managed start');
    },
    watch() { return Object.freeze({ dispose() {} }); },
  });
}

function fullyBoundConnectedAccounts(): ConnectedAccountsService {
  return connectedAccounts(['openai-upstream', 'anthropic-upstream']);
}

async function startWithService(
  service: ManagedServiceHandle,
  signal: AbortSignal = new AbortController().signal,
): Promise<Awaited<ReturnType<ManagedProviderRuntime['start']>>> {
  const runtime = captureRuntime();
  const supervise = vi.fn<ManagedServices['supervise']>(async () => service);
  return runtime.start(startRequests[0], {
    connectedAccounts: fullyBoundConnectedAccounts(),
    managedServices: Object.freeze({
      dependencies: Object.freeze({}) as never,
      supervise,
    }),
    signal,
  });
}

function createService(
  waitUntilHealthy: ManagedServiceHandle['waitUntilHealthy'] = vi.fn(async () => healthySnapshot),
  request: ManagedServiceHandle['request'] = vi.fn(async () => healthyIdentityResponse()),
  snapshot: ManagedServiceHandle['snapshot'] = () => healthySnapshot,
): ManagedServiceHandle {
  return Object.freeze({
    snapshot,
    observe: vi.fn(() => Object.freeze({ dispose() {} })),
    waitUntilHealthy,
    request,
    stop: vi.fn(async () => Object.freeze({ status: 'stopped' as const })),
    dispose: vi.fn(async () => undefined),
  });
}

function captureRuntime(): ManagedProviderRuntime {
  const registrations: Readonly<{
    localId: string;
    runtime: ManagedProviderRuntime;
  }>[] = [];
  const api = Object.freeze({
    providers: Object.freeze({
      register(localId: string, runtime: ManagedProviderRuntime): void {
        registrations.push(Object.freeze({ localId, runtime }));
      },
    }),
  }) satisfies Pick<PluginApi, 'providers'>;

  activate(api);

  const registration = registrations[0];
  if (!registration) throw new Error('CLIProxyAPI activation did not register a Provider runtime');
  expect(registration.localId).toBe('cliproxyapi');
  return registration.runtime;
}

const startRequests = [
  {
    reason: 'explicitStartLocal',
    endpointTemplateIds: [
      'cliproxyapi-openai-responses',
      'cliproxyapi-openai-chat',
      'cliproxyapi-anthropic',
    ],
  },
  {
    reason: 'catalogProbe',
    connectionId: ProviderConnectionIdSchema.parse('connection-catalog'),
    connectionRevision: 3,
    endpointTemplateIds: [
      'cliproxyapi-openai-responses',
      'cliproxyapi-openai-chat',
      'cliproxyapi-anthropic',
    ],
  },
  {
    reason: 'sessionDemand',
    connectionId: ProviderConnectionIdSchema.parse('connection-session'),
    connectionRevision: 4,
    endpointTemplateIds: [
      'cliproxyapi-openai-responses',
      'cliproxyapi-openai-chat',
      'cliproxyapi-anthropic',
    ],
  },
] as const satisfies readonly ManagedProviderStartRequest[];

describe('CLIProxyAPI public managed Provider activation', () => {
  it('exports only the public plugin contract from the package root', () => {
    expect(publicPackage).not.toHaveProperty('MANAGED_PROVIDER_IMPLEMENTATION');
    expect(publicPackage).not.toHaveProperty('MANAGED_PROVIDER_RUNTIME_ADAPTER');
  });

  it.each(startRequests)('registers one runtime and supervises the same public service for $reason', async (request) => {
    const runtime = captureRuntime();
    const service = createService();
    const supervise = vi.fn<ManagedServices['supervise']>(async () => service);
    const signal = new AbortController().signal;

    const result = await runtime.start(request, {
      connectedAccounts: fullyBoundConnectedAccounts(),
      managedServices: Object.freeze({
        dependencies: Object.freeze({}) as never,
        supervise,
      }),
      signal,
    });

    expect(supervise).toHaveBeenCalledOnce();
    expect(supervise).toHaveBeenCalledWith({
      id: 'cliproxyapi-managed',
      requestAuth: {
        kind: 'connectedAccountCapabilityPath',
        injectEnvironmentKey: 'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH',
      },
      clientAccess: {
        kind: 'hostBearer',
        injectEnvironmentKey: 'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER',
        headerName: 'authorization',
        scheme: 'Bearer',
      },
      mode: {
        kind: 'spawn',
        launch: {
          executable: {
            kind: 'packaged-runtime-binary',
            directorySegments: ['tools', 'unpacked'],
            executableBaseName: 'happier-cliproxyapi-managed',
          },
          env: {
            HOST: '127.0.0.1',
            HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION:
              fullyBoundPurposeConfiguration,
          },
        },
        endpoint: {
          kind: 'assignAndInject',
          host: '127.0.0.1',
          port: { kind: 'allocated' },
          inject: { portEnvironmentKey: 'PORT' },
        },
      },
      healthCheck: {
        kind: 'http',
        target: { kind: 'servicePath', path: '/healthz' },
      },
    }, { signal });
    expect(service.waitUntilHealthy).toHaveBeenCalledWith({ signal });
    expect(service.request).toHaveBeenCalledWith({
      pathAndQuery: '/healthz',
      method: 'GET',
      signal,
    });
    expect(result).toEqual({
      service,
      endpoints: [
        {
          endpointTemplateId: 'cliproxyapi-openai-responses',
          endpoint: { kind: 'servicePath', path: '/v1' },
        },
        {
          endpointTemplateId: 'cliproxyapi-openai-chat',
          endpoint: { kind: 'servicePath', path: '/v1' },
        },
        {
          endpointTemplateId: 'cliproxyapi-anthropic',
          endpoint: { kind: 'servicePath', path: '/' },
        },
      ],
    });
    expect(JSON.stringify(supervise.mock.calls[0]?.[0])).not.toContain('capability.json');
    expect(JSON.stringify(result)).not.toContain('downstream-secret');
  });

  it('keeps the declared catalog probe reachable when only Anthropic is bound', async () => {
    expect(CLIPROXYAPI_PROVIDER_CONTRIBUTION.catalog.probes).toHaveLength(1);
    const catalogProbe = CLIPROXYAPI_PROVIDER_CONTRIBUTION.catalog.probes[0];
    if (!catalogProbe) throw new Error('CLIProxyAPI must declare one catalog probe');
    const managedRuntime = CLIPROXYAPI_PROVIDER_CONTRIBUTION.managedRuntime;
    if (!managedRuntime) throw new Error('CLIProxyAPI must declare a managed runtime');
    const runtime = captureRuntime();
    const service = createService(undefined, vi.fn(async () => response(
      JSON.stringify(anthropicOnlyIdentity),
    )));
    const supervise = vi.fn<ManagedServices['supervise']>(async () => service);
    const signal = new AbortController().signal;

    const result = await runtime.start({
      reason: 'catalogProbe',
      connectionId: ProviderConnectionIdSchema.parse('connection-anthropic-catalog'),
      connectionRevision: 5,
      endpointTemplateIds: managedRuntime.endpointTemplateIds,
    }, {
      connectedAccounts: connectedAccounts(['anthropic-upstream']),
      managedServices: Object.freeze({
        dependencies: Object.freeze({}) as never,
        supervise,
      }),
      signal,
    });

    expect(supervise).toHaveBeenCalledWith(expect.objectContaining({
      mode: expect.objectContaining({
        launch: expect.objectContaining({
          env: expect.objectContaining({
            HAPPIER_CLIPROXYAPI_MANAGED_PURPOSE_CONFIGURATION:
              anthropicOnlyPurposeConfiguration,
          }),
        }),
      }),
    }), { signal });
    expect(result.endpoints).toEqual([{
      endpointTemplateId: catalogProbe.endpointTemplateId,
      endpoint: { kind: 'servicePath', path: '/v1' },
    }, {
      endpointTemplateId: 'cliproxyapi-anthropic',
      endpoint: { kind: 'servicePath', path: '/' },
    }]);
  });

  it('disposes the newly supervised service when readiness fails', async () => {
    const runtime = captureRuntime();
    const readinessFailure = new Error('managed wrapper readiness failed');
    const service = createService(vi.fn(async () => Promise.reject(readinessFailure)));
    const supervise = vi.fn<ManagedServices['supervise']>(async () => service);

    await expect(runtime.start(startRequests[0], {
      connectedAccounts: fullyBoundConnectedAccounts(),
      managedServices: Object.freeze({
        dependencies: Object.freeze({}) as never,
        supervise,
      }),
      signal: new AbortController().signal,
    })).rejects.toBe(readinessFailure);
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(service.request).not.toHaveBeenCalled();
  });

  it('disposes a healthy service whose 2xx body has the wrong wrapper identity', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => response(
      JSON.stringify({ status: 'ok' }),
    ));
    const service = createService(undefined, request);

    await expect(startWithService(service))
      .rejects.toThrow('CLIProxyAPI managed wrapper identity');
    expect(request).toHaveBeenCalledOnce();
    expect(service.dispose).toHaveBeenCalledOnce();
  });

  it('accepts a distinct bounded diagnostic build label without treating it as runtime provenance', async () => {
    const request = vi.fn<ManagedServiceHandle['request']>(async () => response(
      JSON.stringify({
        ...healthyIdentity,
        wrapperBuildVersion: 'another-valid-wrapper-build',
      }),
    ));
    const service = createService(undefined, request);

    await expect(startWithService(service)).resolves.toEqual(expect.objectContaining({
      service,
    }));
    expect(request).toHaveBeenCalledOnce();
    expect(service.dispose).not.toHaveBeenCalled();
  });

  it.each([
    ['version', { ...healthyIdentity, v: 2 }],
    ['contract', { ...healthyIdentity, contractVersion: 'wrong-contract' }],
    ['SDK pin', { ...healthyIdentity, sdkVersion: 'v7.2.94' }],
    ['blank build', { ...healthyIdentity, wrapperBuildVersion: '' }],
    ['untrimmed build', { ...healthyIdentity, wrapperBuildVersion: ' build-1 ' }],
    ['oversized build', { ...healthyIdentity, wrapperBuildVersion: 'é'.repeat(65) }],
    ['protocol order', {
      ...healthyIdentity,
      protocols: ['openai-responses', 'openai-chat', 'anthropic'],
    }],
    ['qualified purposes', {
      ...healthyIdentity,
      purposes: [healthyIdentity.purposes[1], healthyIdentity.purposes[0]],
    }],
    ['qualified purpose consumer', {
      ...healthyIdentity,
      purposes: [
        {
          ...healthyIdentity.purposes[0],
          consumer: {
            ...healthyIdentity.purposes[0].consumer,
            pluginId: 'happier.provider.wrong',
          },
        },
        healthyIdentity.purposes[1],
      ],
    }],
    ['model-list fact', { ...healthyIdentity, modelListEnabled: false }],
    ['unknown top-level fact', { ...healthyIdentity, unexpected: true }],
    ['unknown nested purpose fact', {
      ...healthyIdentity,
      purposes: [
        { ...healthyIdentity.purposes[0], unexpected: true },
        healthyIdentity.purposes[1],
      ],
    }],
  ] as const)('rejects a mismatched %s fact', async (_name, identity) => {
    const service = createService(undefined, vi.fn(async () => response(
      JSON.stringify(identity),
    )));

    await expect(startWithService(service))
      .rejects.toThrow('CLIProxyAPI managed wrapper identity');
    expect(service.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['malformed JSON', () => response('{"v":')],
    ['invalid UTF-8', () => response(new Uint8Array([0xc3, 0x28]))],
    ['oversized body', () => response('x'.repeat(16 * 1024 + 1))],
    ['non-2xx status', () => response(JSON.stringify(healthyIdentity), { status: 503 })],
    ['wrong media type', () => response(JSON.stringify(healthyIdentity), {
      contentType: 'text/plain',
    })],
    ['missing body', () => Object.freeze({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: null,
    }) satisfies ManagedServiceResponse],
  ] as const)('rejects a %s health response', async (_name, makeResponse) => {
    const service = createService(undefined, vi.fn(async () => makeResponse()));

    await expect(startWithService(service))
      .rejects.toThrow('CLIProxyAPI managed wrapper identity');
    expect(service.dispose).toHaveBeenCalledOnce();
  });

  it('propagates exact-handle request failure and disposes only the acquired claim', async () => {
    const requestFailure = new Error('exact managed request failed');
    const service = createService(undefined, vi.fn(async () => {
      throw requestFailure;
    }));

    await expect(startWithService(service)).rejects.toBe(requestFailure);
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('rejects late cancellation after the identity request and disposes once', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancelled after identity request');
    const service = createService(undefined, vi.fn(async () => {
      controller.abort(cancellation);
      return healthyIdentityResponse();
    }));

    await expect(startWithService(service, controller.signal))
      .rejects.toBe(cancellation);
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('rejects a service that becomes stale while its identity body is read', async () => {
    let stale = false;
    const service = createService(
      undefined,
      vi.fn(async () => {
        stale = true;
        return healthyIdentityResponse();
      }),
      () => stale
        ? Object.freeze({ ...healthySnapshot, state: 'failed' as const })
        : healthySnapshot,
    );

    await expect(startWithService(service))
      .rejects.toThrow('CLIProxyAPI managed service became unhealthy');
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(service.stop).not.toHaveBeenCalled();
  });
});
