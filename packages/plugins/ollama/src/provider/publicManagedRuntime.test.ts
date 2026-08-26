import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedServiceHandle,
  ManagedServiceSnapshot,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';

import { OLLAMA_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './publicManagedRuntime.js';

const HEALTHY_SNAPSHOT = Object.freeze({
  id: 'ollama-managed',
  state: 'healthy' as const,
  mode: 'spawn' as const,
  baseUrl: null,
  startedAtMs: 1,
  lastHealthyAtMs: 1,
  diagnostics: Object.freeze([]),
  diagnosticsTruncated: false,
}) satisfies ManagedServiceSnapshot;

function serviceHandle(
  waitUntilHealthy: ManagedServiceHandle['waitUntilHealthy'] = vi.fn(
    async () => HEALTHY_SNAPSHOT,
  ),
) {
  return {
    snapshot: () => HEALTHY_SNAPSHOT,
    observe: vi.fn(() => ({ dispose: vi.fn() })),
    waitUntilHealthy,
    request: vi.fn(async () => {
      throw new Error('Unexpected managed service request');
    }),
    stop: vi.fn(async () => ({ status: 'stopped' as const })),
    dispose: vi.fn(async () => undefined),
  } satisfies ManagedServiceHandle;
}

describe('Ollama public managed Provider runtime', () => {
  it('supervises the declared system tool once and projects every endpoint as a service path', async () => {
    const service = serviceHandle();
    const supervise = vi.fn(async () => service);
    const signal = new AbortController().signal;
    const result = await OLLAMA_PUBLIC_MANAGED_PROVIDER_RUNTIME.start({
      reason: 'explicitStartLocal',
      endpointTemplateIds: [
        'ollama-native',
        'ollama-openai-chat',
        'ollama-openai-responses',
      ],
    }, {
      connectedAccounts: {} as ConnectedAccountsService,
      managedServices: {
        dependencies: {} as ManagedServices['dependencies'],
        supervise,
      },
      signal,
    });

    expect(supervise).toHaveBeenCalledOnce();
    expect(service.waitUntilHealthy).toHaveBeenCalledWith({ signal });
    expect(service.request).not.toHaveBeenCalled();
    expect(service.dispose).not.toHaveBeenCalled();
    expect(supervise).toHaveBeenCalledWith({
      id: 'ollama-managed',
      mode: {
        kind: 'spawn',
        launch: {
          executable: { kind: 'systemTool', id: 'ollama-cli' },
          args: ['serve'],
        },
        endpoint: {
          kind: 'assignAndInject',
          host: '127.0.0.1',
          port: {
            kind: 'allocated',
            preferredPort: 11434,
            onCollision: 'fallback',
          },
          inject: { baseUrlEnvironmentKey: 'OLLAMA_HOST' },
        },
      },
      healthCheck: {
        kind: 'http',
        target: { kind: 'servicePath', path: '/api/tags' },
      },
    }, { signal });
    expect(result).toEqual({
      service,
      endpoints: [
        { endpointTemplateId: 'ollama-native', endpoint: { kind: 'servicePath', path: '/' } },
        { endpointTemplateId: 'ollama-openai-chat', endpoint: { kind: 'servicePath', path: '/v1' } },
        { endpointTemplateId: 'ollama-openai-responses', endpoint: { kind: 'servicePath', path: '/v1' } },
      ],
    });
  });

  it('disposes the acquired service when readiness does not become healthy', async () => {
    const service = serviceHandle(vi.fn(async () => Object.freeze({
      ...HEALTHY_SNAPSHOT,
      state: 'unhealthy' as const,
    })));
    const signal = new AbortController().signal;

    await expect(OLLAMA_PUBLIC_MANAGED_PROVIDER_RUNTIME.start({
      reason: 'explicitStartLocal',
      endpointTemplateIds: ['ollama-native'],
    }, {
      connectedAccounts: {} as ConnectedAccountsService,
      managedServices: {
        dependencies: {} as ManagedServices['dependencies'],
        supervise: vi.fn(async () => service),
      },
      signal,
    })).rejects.toThrow();

    expect(service.dispose).toHaveBeenCalledOnce();
  });
});
