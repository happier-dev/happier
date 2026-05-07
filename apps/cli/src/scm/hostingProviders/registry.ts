import { bitbucketScmHostingProviderAdapter } from './providers/bitbucket';
import { githubRestScmHostingProviderAdapter } from './providers/githubRestAdapter';
import { gitlabScmHostingProviderAdapter } from './providers/gitlab';
import type {
    ScmHostingProviderAdapter,
    ScmHostingProviderCompareUrlInput,
    ScmHostingProviderDetectionInput,
    ScmHostingProviderRegistry,
} from './types';

export function createScmHostingProviderRegistry(
    initialAdapters: readonly ScmHostingProviderAdapter[] = [],
): ScmHostingProviderRegistry {
    const adapters = new Map<string, ScmHostingProviderAdapter>();

    const registry: ScmHostingProviderRegistry = {
        registerScmHostingProvider(adapter) {
            adapters.set(adapter.kind, adapter);
        },
        detectRemote(input: ScmHostingProviderDetectionInput) {
            for (const adapter of adapters.values()) {
                const detected = adapter.detectRemote(input);
                if (detected) return detected;
            }
            return null;
        },
        buildCompareUrl(input: ScmHostingProviderCompareUrlInput) {
            return adapters.get(input.provider.kind)?.buildCompareUrl(input) ?? null;
        },
    };

    for (const adapter of initialAdapters) {
        registry.registerScmHostingProvider(adapter);
    }

    return registry;
}

export function createDefaultScmHostingProviderRegistry(): ScmHostingProviderRegistry {
    return createScmHostingProviderRegistry([
        githubRestScmHostingProviderAdapter,
        gitlabScmHostingProviderAdapter,
        bitbucketScmHostingProviderAdapter,
    ]);
}

export const defaultScmHostingProviderRegistry = createDefaultScmHostingProviderRegistry();

export function registerScmHostingProvider(adapter: ScmHostingProviderAdapter): void {
    defaultScmHostingProviderRegistry.registerScmHostingProvider(adapter);
}
