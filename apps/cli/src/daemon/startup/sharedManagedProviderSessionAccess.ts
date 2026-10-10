import { PluginError } from '@happier-dev/plugin-sdk';

import type { ResolvedManagedProviderRuntimeInvocationServices } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

type MaterializeSharedBinding = NonNullable<ResolvedManagedProviderRuntimeInvocationServices['materializeManagedProviderAgentBinding']>;
type SharedProjection = Pick<Parameters<MaterializeSharedBinding>[0], 'service' | 'projection'>;

/** Reads the exact daemon-owned consumer projection without rematerializing the Agent. */
export function createSharedManagedProviderSessionAccess(input: Readonly<{
    start(): Promise<void>;
    readProjection(): SharedProjection | null;
    materialize?: MaterializeSharedBinding;
    endpointTemplateId: string;
    revalidate(): Promise<boolean>;
    cleanup(): Promise<void>;
}>) {
    return async (requestSignal?: AbortSignal) => {
        requestSignal?.throwIfAborted();
        await input.start();
        const captured = input.readProjection();
        if (!captured || !input.materialize || !await input.revalidate()) {
            await input.cleanup();
            throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message: 'Managed gateway consumer access is unavailable',
            });
        }
        requestSignal?.throwIfAborted();
        const result = await input.materialize({
            ...captured,
            endpointTemplateId: input.endpointTemplateId,
            async materialize({ credentialPlaceholder }) {
                return {
                    v: 1,
                    kind: 'spawnEnv',
                    env: credentialPlaceholder === null ? [] : [{
                        name: 'HAPPIER_PROVIDER_GATEWAY_ACCESS',
                        value: credentialPlaceholder,
                        source: 'provider',
                    }],
                };
            },
        });
        if (!result) {
            await input.cleanup();
            throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message: 'Managed gateway consumer access changed',
            });
        }
        requestSignal?.throwIfAborted();
        return result.httpBinding;
    };
}
