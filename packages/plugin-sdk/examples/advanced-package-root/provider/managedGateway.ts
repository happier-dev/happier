import type { ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';

/**
 * A managed Provider owns protocol adaptation only. The host owns the
 * supervised child, credential binding, adoption, health, and retirement.
 */
export const managedGatewayRuntime: ManagedProviderRuntime = {
    async start(request, context) {
        const service = await context.managedServices.supervise({
            id: 'example-gateway',
            mode: {
                kind: 'attach',
                baseUrl: 'http://127.0.0.1:3210',
            },
            healthCheck: { kind: 'none' },
        }, { signal: context.signal });

        await service.waitUntilHealthy({ signal: context.signal });
        return {
            service,
            endpoints: request.endpointTemplateIds.map((endpointTemplateId) => ({
                endpointTemplateId,
                endpoint: { kind: 'servicePath' as const, path: '/v1' },
            })),
        };
    },
};
