import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

const OLLAMA_MANAGED_SERVICE_SPEC = Object.freeze({
  id: 'ollama-managed',
  mode: Object.freeze({
    kind: 'spawn' as const,
    launch: Object.freeze({
      executable: Object.freeze({
        kind: 'systemTool' as const,
        id: 'ollama-cli',
      }),
      args: Object.freeze(['serve']),
    }),
    endpoint: Object.freeze({
      kind: 'assignAndInject' as const,
      host: '127.0.0.1' as const,
      port: Object.freeze({
        kind: 'allocated' as const,
        preferredPort: 11_434,
        onCollision: 'fallback' as const,
      }),
      inject: Object.freeze({ baseUrlEnvironmentKey: 'OLLAMA_HOST' }),
    }),
  }),
  // `/api/tags` is Ollama's declared availability and catalog endpoint. SVC09
  // owns the retry, timeout, cancellation, and readiness lifecycle around this
  // one provider-native HTTP check.
  healthCheck: Object.freeze({
    kind: 'http' as const,
    target: Object.freeze({
      kind: 'servicePath' as const,
      path: '/api/tags',
    }),
  }),
}) satisfies ManagedServiceSpec;

const start: ManagedProviderRuntime['start'] = async (request, context) => {
  const service = await context.managedServices.supervise(
    OLLAMA_MANAGED_SERVICE_SPEC,
    { signal: context.signal },
  );
  try {
    const snapshot = await service.waitUntilHealthy({ signal: context.signal });
    if (snapshot.state !== 'healthy') {
      throw new Error('Ollama managed service did not become healthy');
    }
  } catch (error) {
    try {
      await service.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Ollama managed service readiness and cleanup failed',
      );
    }
    throw error;
  }

  const servicePathByEndpointTemplateId = new Map([
    ['ollama-native', '/'],
    ['ollama-openai-chat', '/v1'],
    ['ollama-openai-responses', '/v1'],
  ]);
  return Object.freeze({
    service,
    endpoints: Object.freeze(request.endpointTemplateIds.map(
      (endpointTemplateId) => Object.freeze({
        endpointTemplateId,
        endpoint: Object.freeze({
          kind: 'servicePath' as const,
          path: servicePathByEndpointTemplateId.get(endpointTemplateId)
            ?? '/',
        }),
      }),
    )),
  });
};

export const OLLAMA_PUBLIC_MANAGED_PROVIDER_RUNTIME: ManagedProviderRuntime =
  Object.freeze({ start });
