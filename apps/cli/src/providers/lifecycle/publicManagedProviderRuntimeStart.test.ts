import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';

import type {
  ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import {
  PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
  ProviderConnectionIdSchema,
} from '@happier-dev/protocol';

import type { ResolvedManagedProviderRuntime } from '@/plugins/projection/registry/types';

import { createProviderLaunchResourceScope } from './resourceScope';
import { startPublicManagedProviderRuntime } from './publicManagedProviderRuntimeStart';

function connectedAccounts(): ConnectedAccountsService {
  return Object.freeze({
    async getBinding() { return null; },
    async requestSelection() { throw new Error('selection is unavailable during activation'); },
    async materialize() { throw new Error('no materialization expected'); },
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch() { return Object.freeze({ dispose() {} }); },
  });
}

function managedServiceHandle(
  dispose: ManagedServiceHandle['dispose'] = vi.fn(async () => undefined),
): ManagedServiceHandle {
  const snapshot = Object.freeze({
    id: 'cliproxyapi',
    state: 'healthy' as const,
    mode: 'spawn' as const,
    baseUrl: 'http://127.0.0.1:45123',
    startedAtMs: 10,
    lastHealthyAtMs: 11,
    diagnostics: Object.freeze([]),
    diagnosticsTruncated: false,
  });
  return Object.freeze({
    snapshot: () => snapshot,
    observe(listener: Parameters<ManagedServiceHandle['observe']>[0]) {
      listener(snapshot);
      return Object.freeze({ dispose() {} });
    },
    async waitUntilHealthy() { return snapshot; },
    async request() { throw new Error('Unexpected managed service request'); },
    async stop() { return Object.freeze({ status: 'stopped' as const }); },
    dispose,
  });
}

function managedServices(): ManagedServices {
  const unavailable = async (): Promise<never> => {
    throw new Error('not used');
  };
  return Object.freeze({
    dependencies: Object.freeze({
      status: unavailable,
      ensure: unavailable,
      update: unavailable,
      remove: unavailable,
    }),
    supervise: unavailable,
  });
}

function resolvedRuntime(
  runtime: ManagedProviderRuntime,
  isCurrent: () => boolean = () => true,
): ResolvedManagedProviderRuntime {
  return Object.freeze({
    runtime,
    activationGeneration: 'activation-7',
    immutableGenerationId: 'immutable-7',
    isCurrent,
  });
}

describe('public managed Provider runtime start coordinator', () => {
  it('snapshots the authorized request before invoking plugin code', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const endpointTemplateIds = ['responses'];
    const request = {
      reason: 'explicitStartLocal' as const,
      endpointTemplateIds,
    };
    const start = vi.fn<ManagedProviderRuntime['start']>(async (received) => {
      endpointTemplateIds[0] = 'not-authorized';
      expect(received).not.toBe(request);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.endpointTemplateIds)).toBe(true);
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'not-authorized',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    });
    const runtime = resolvedRuntime(Object.freeze({ start }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request,
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects an unknown reason before runtime acquisition', async () => {
    const acquireRuntime = vi.fn();
    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: {
        reason: 'unknown-reason',
        connectionId: ProviderConnectionIdSchema.parse('connection-1'),
        connectionRevision: 4,
        endpointTemplateIds: ['responses'],
      } as never,
      acquireRuntime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_request_invalid' });
    expect(acquireRuntime).not.toHaveBeenCalled();
  });

  it('reports a pre-aborted invocation before runtime acquisition', async () => {
    const controller = new AbortController();
    controller.abort('cancelled before admission');
    const acquireRuntime = vi.fn();
    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: controller.signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_aborted' });
    expect(acquireRuntime).not.toHaveBeenCalled();
  });

  it('reports cancellation when initial runtime acquisition settles unavailable after abort', async () => {
    const controller = new AbortController();
    const acquireRuntime = vi.fn(async () => {
      controller.abort('cancelled while acquiring runtime');
      return null;
    });

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: controller.signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_aborted' });
    expect(acquireRuntime).toHaveBeenCalledOnce();
  });

  it('preserves a missing custody helper as runtime unavailable', async () => {
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => {
        throw new PluginError({
          code: 'plugin_managed_server_custody_failed',
          message: 'Managed server process-tree custody helper is unavailable on Windows',
        });
      },
    }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({
      ok: false,
      code: 'managed_provider_runtime_unavailable',
    });
  });

  it('preserves packaged runtime binary absence as runtime unavailable', async () => {
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => {
        throw new PluginError({
          code: 'plugin_packaged_runtime_binary_unavailable',
          message: 'runtime installation is unavailable',
        });
      },
    }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({ reason: 'explicitStartLocal' as const, endpointTemplateIds: Object.freeze(['responses']) }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({ managedServices: managedServices(), projectEndpointAccess: vi.fn() }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_runtime_unavailable' });
  });

  it.each([
    'Managed server job custody could not be established',
    'Managed server process identity could not be captured safely',
    'Managed server custody could not be established',
  ])('keeps transient managed custody failure retryable (%s)', async (message) => {
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => {
        throw new PluginError({ code: 'plugin_managed_server_custody_failed', message });
      },
    }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({ reason: 'explicitStartLocal' as const, endpointTemplateIds: Object.freeze(['responses']) }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({ managedServices: managedServices(), projectEndpointAccess: vi.fn() }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_failed' });
  });

  it('reports cancellation after Provider admission without misclassifying it as authorization drift', async () => {
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => {
        controller.abort('cancelled after Provider admission');
        return Object.freeze({
          service,
          endpoints: Object.freeze([Object.freeze({
            endpointTemplateId: 'responses',
            endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
          })]),
        });
      },
    }));
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: controller.signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_aborted' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports cancellation before classifying a malformed result', async () => {
    const controller = new AbortController();
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => {
        controller.abort('cancelled while Provider result settled');
        return null as never;
      },
    }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: controller.signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_aborted' });
  });

  it('reports cancellation before classifying a settled runtime mismatch', async () => {
    const controller = new AbortController();
    const service = managedServiceHandle();
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    }));
    let acquisitions = 0;

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => {
        acquisitions += 1;
        if (acquisitions === 1) return runtime;
        controller.abort('cancelled while reacquiring runtime');
        return null;
      },
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: controller.signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_aborted' });
  });

  it('reports cancellation during endpoint-access projection and retires the admitted service', async () => {
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    }));
    const projectEndpointAccess = vi.fn(async () => {
      controller.abort('cancelled while projecting endpoint access');
      return null;
    });

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({ managedServices: managedServices(), projectEndpointAccess }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: controller.signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_start_aborted' });
    expect(projectEndpointAccess).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('invokes the exact acquired public runtime once and publishes only a current opaque SVC09 projection', async () => {
    const service = managedServiceHandle();
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => Object.freeze({
      service,
      endpoints: Object.freeze([
        Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        }),
      ]),
    }));
    const acquired = resolvedRuntime(Object.freeze({ start }));
    const acquireRuntime = vi.fn(async () => acquired);
    const revalidateAuthorization = vi.fn(async () => true);
    const projectionCleanup = vi.fn(async () => undefined);
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ kind: 'opaque-endpoint-access' as const }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const launchResourceScope = createProviderLaunchResourceScope();
    const accounts = connectedAccounts();
    const services = managedServices();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'catalogProbe' as const,
        connectionId: ProviderConnectionIdSchema.parse('connection-1'),
        connectionRevision: 4,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime,
      connectedAccounts: accounts,
      custody: Object.freeze({ managedServices: services, projectEndpointAccess }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization,
      signal: new AbortController().signal,
      launchResourceScope,
    });

    expect(result).toMatchObject({
      ok: true,
      access: { kind: 'opaque-endpoint-access' },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'catalogProbe',
        connectionId: ProviderConnectionIdSchema.parse('connection-1'),
        connectionRevision: 4,
        endpointTemplateIds: ['responses'],
      }),
      expect.objectContaining({
        connectedAccounts: accounts,
        managedServices: services,
      }),
    );
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(revalidateAuthorization).toHaveBeenCalledTimes(3);
    expect(projectEndpointAccess).toHaveBeenCalledWith(expect.objectContaining({
      service,
      endpoints: [{ endpointTemplateId: 'responses', servicePath: '/v1' }],
    }));
    expect(result.ok && result.isCurrent()).toBe(true);

    await launchResourceScope.release();
    expect(projectionCleanup).toHaveBeenCalledTimes(1);
  });

  it('accepts an additive trusted managed endpoint result and retains lifecycle custody', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const endpointResult = Object.freeze({
      service,
      endpoints: Object.freeze([Object.freeze({
        endpointTemplateId: 'responses',
        endpoint: Object.freeze({
          kind: 'servicePath' as const,
          path: '/v1',
          pluginMetadata: Object.freeze({ source: 'cliproxyapi' }),
        }),
        pluginMetadata: Object.freeze({ feature: 'responses' }),
      })]),
      pluginMetadata: Object.freeze({ version: 2 }),
    });
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ kind: 'opaque-endpoint-access' as const }),
      isCurrent: () => true,
    }));
    const launchResourceScope = createProviderLaunchResourceScope();
    const runtime = resolvedRuntime(Object.freeze({ start: async () => endpointResult }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
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
    expect(projectEndpointAccess).toHaveBeenCalledOnce();

    await launchResourceScope.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a settled runtime whose direct registration or generation changed', async () => {
    const service = managedServiceHandle();
    const runtime = Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    });
    const acquired = resolvedRuntime(runtime);
    const replacementRuntime = Object.freeze({ start: runtime.start });
    const settledRuntimes = [
      Object.freeze({ ...acquired, runtime: replacementRuntime }),
      Object.freeze({ ...acquired, activationGeneration: 'activation-8' }),
      Object.freeze({ ...acquired, immutableGenerationId: 'immutable-8' }),
    ] satisfies readonly ResolvedManagedProviderRuntime[];

    for (const settled of settledRuntimes) {
      let acquisitions = 0;
      const projectEndpointAccess = vi.fn();
      const result = await startPublicManagedProviderRuntime({
        identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
        request: Object.freeze({
          reason: 'explicitStartLocal' as const,
          endpointTemplateIds: Object.freeze(['responses']),
        }),
        acquireRuntime: async () => {
          acquisitions += 1;
          return acquisitions === 1 ? acquired : settled;
        },
        connectedAccounts: connectedAccounts(),
        custody: Object.freeze({
          managedServices: managedServices(),
          projectEndpointAccess,
        }),
        isAuthorizationCurrent: () => true,
        revalidateAuthorization: async () => true,
        signal: new AbortController().signal,
        launchResourceScope: createProviderLaunchResourceScope(),
      });

      expect(result).toEqual({
        ok: false,
        code: 'managed_provider_authorization_changed',
      });
      expect(projectEndpointAccess).not.toHaveBeenCalled();
    }
  });

  it('rejects a reordered runtime result and disposes the returned handle exactly once', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([
          Object.freeze({
            endpointTemplateId: 'chat',
            endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/chat' }),
          }),
          Object.freeze({
            endpointTemplateId: 'responses',
            endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
          }),
        ]),
      }),
    }));
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses', 'chat']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('accepts a nonempty request-ordered endpoint subset and retains ordinary cleanup custody', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'chat',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/chat' }),
        })]),
      }),
    }));
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ kind: 'opaque-endpoint-access' as const }),
      isCurrent: () => true,
    }));
    const launchResourceScope = createProviderLaunchResourceScope();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses', 'chat']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
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
    expect(projectEndpointAccess).toHaveBeenCalledWith(expect.objectContaining({
      endpoints: [{ endpointTemplateId: 'chat', servicePath: '/chat' }],
    }));

    await launchResourceScope.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('starts every endpoint the Protocol lets one Provider declare', async () => {
    const endpointTemplateIds = Object.freeze(
      Array.from(
        { length: PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration },
        (_unused, index) => `endpoint-${index}`,
      ),
    );
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze(endpointTemplateIds.map((endpointTemplateId) => (
          Object.freeze({
            endpointTemplateId,
            endpoint: Object.freeze({
              kind: 'servicePath' as const,
              path: `/${endpointTemplateId}`,
            }),
          })
        ))),
      }),
    }));
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ kind: 'opaque-endpoint-access' as const }),
      isCurrent: () => true,
    }));
    const launchResourceScope = createProviderLaunchResourceScope();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds,
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope,
    });

    expect(endpointTemplateIds.length).toBeGreaterThan(4);
    expect(result).toMatchObject({ ok: true });
    expect(projectEndpointAccess).toHaveBeenCalledWith(expect.objectContaining({
      endpoints: endpointTemplateIds.map((endpointTemplateId) => ({
        endpointTemplateId,
        servicePath: `/${endpointTemplateId}`,
      })),
    }));

    await launchResourceScope.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects an endpoint id that was not requested and disposes the returned handle', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'invented',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    }));
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses', 'chat']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a non-string endpoint id returned across the plugin boundary', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const endpoint = Object.freeze({
      endpointTemplateId: 42 as never,
      endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
    });
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([endpoint]),
      }),
    }));
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a duplicated returned endpoint id and disposes the returned handle', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([
          Object.freeze({
            endpointTemplateId: 'responses',
            endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
          }),
          Object.freeze({
            endpointTemplateId: 'responses',
            endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
          }),
        ]),
      }),
    }));
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses', 'chat']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a returned managed service handle without request before endpoint publication', async () => {
    const dispose = vi.fn(async () => undefined);
    const { request: _request, ...serviceWithoutRequest } = managedServiceHandle(dispose);
    const service = Object.freeze(serviceWithoutRequest);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service: service as never,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    }));
    const projectEndpointAccess = vi.fn();
    const release = vi.fn();
    const launchResourceScope = createProviderLaunchResourceScope();
    launchResourceScope.register(release);

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope,
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('keeps endpoint-path safety when the trusted result carries additive fields', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([
          Object.freeze({
            endpointTemplateId: 'responses',
            endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1?unsafe' }),
            pluginMetadata: Object.freeze({ feature: 'responses' }),
          }),
        ]),
        pluginMetadata: Object.freeze({ version: 2 }),
      }),
    }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_result_invalid' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects late settlement after authorization changes and publishes no endpoint access', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    let current = true;
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => {
        current = false;
        return Object.freeze({
          service,
          endpoints: Object.freeze([
            Object.freeze({
              endpointTemplateId: 'responses',
              endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
            }),
          ]),
        });
      },
    }), () => current);
    const projectEndpointAccess = vi.fn();

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'sessionDemand' as const,
        connectionId: ProviderConnectionIdSchema.parse('connection-1'),
        connectionRevision: 4,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess,
      }),
      isAuthorizationCurrent: () => current,
      revalidateAuthorization: async () => current,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_authorization_changed' });
    expect(projectEndpointAccess).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts the invocation before failure cleanup retires Provider-owned resources', async () => {
    let current = true;
    const dispose = vi.fn(async () => undefined);
    const start: ManagedProviderRuntime['start'] = async (_request, context) => {
      const service = managedServiceHandle(async () => {
        if (!context.signal.aborted) {
          throw new Error('cleanup ran before invocation fencing');
        }
        await dispose();
      });
      current = false;
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    };
    const runtime = resolvedRuntime(Object.freeze({
      start,
    }), () => current);

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: vi.fn(),
      }),
      isAuthorizationCurrent: () => current,
      revalidateAuthorization: async () => current,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({ ok: false, code: 'managed_provider_authorization_changed' });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('leaves an adopted Session service with runner custody when the daemon projection retires', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const projectionCleanup = vi.fn(async () => undefined);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    }));
    const launchResourceScope = createProviderLaunchResourceScope();
    const adoptService = vi.fn(async () => undefined);

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'sessionDemand' as const,
        connectionId: ProviderConnectionIdSchema.parse('connection-1'),
        connectionRevision: 4,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        adoptService,
        projectEndpointAccess: async () => Object.freeze({
          access: Object.freeze({ kind: 'runner-owned-access' as const }),
          isCurrent: () => true,
          cleanup: projectionCleanup,
        }),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope,
    });

    expect(result).toMatchObject({ ok: true });
    expect(adoptService).toHaveBeenCalledWith('cliproxyapi');

    const retireDaemonProjection = launchResourceScope.transfer();
    await retireDaemonProjection?.();

    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('fails and cleans an unadopted Session service when custody adoption is unavailable', async () => {
    const dispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(dispose);
    const runtime = resolvedRuntime(Object.freeze({
      start: async () => Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'responses',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      }),
    }));

    const result = await startPublicManagedProviderRuntime({
      identity: Object.freeze({ pluginId: 'cliproxyapi', localId: 'cliproxyapi' }),
      request: Object.freeze({
        reason: 'sessionDemand' as const,
        connectionId: ProviderConnectionIdSchema.parse('connection-1'),
        connectionRevision: 4,
        endpointTemplateIds: Object.freeze(['responses']),
      }),
      acquireRuntime: async () => runtime,
      connectedAccounts: connectedAccounts(),
      custody: Object.freeze({
        managedServices: managedServices(),
        projectEndpointAccess: async () => Object.freeze({
          access: Object.freeze({ kind: 'runner-owned-access' as const }),
          isCurrent: () => true,
        }),
      }),
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
      signal: new AbortController().signal,
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result).toEqual({
      ok: false,
      code: 'managed_provider_custody_adoption_failed',
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

});
