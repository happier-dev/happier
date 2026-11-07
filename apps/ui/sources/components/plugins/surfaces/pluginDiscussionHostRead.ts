import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Content-free observation over the incumbent AccountChange and Resource owners. */
export function createPluginDiscussionHostReadStore(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
}>): PluginUiResourceStore {
    const repository = async () => {
        // Resolve on demand: the Action client reaches plugin composition too,
        // so importing it while constructing that composition forms a cycle.
        const { getDiscussionRepository, readRegisteredDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
        const existing = readRegisteredDiscussionRepository(input.lifetime.scope, input.lifetime.scope);
        if (existing) return existing;
        const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
        return getDiscussionRepository({ scope: input.lifetime.scope, address: input.lifetime.scope,
            accountLifetime: input.lifetime,
            client: createDiscussionClient({ scope: input.lifetime.scope, availability: 'available' }) });
    };
    const discussionIdFor = async (resource: Parameters<PluginUiResourceStore['getEntry']>[0]): Promise<string> => {
        if (typeof resource === 'string' || !('hostRead' in resource) || resource.hostRead !== 'discussion.get') {
            throw Object.assign(new Error('Unsupported Discussion host read'), { code: 'unsupported_method', retryable: false });
        }
        const { DiscussionGetInputV1Schema } = await import('@happier-dev/protocol/discussions/actions');
        return DiscussionGetInputV1Schema.parse(resource.input).discussionId;
    };
    return createPluginUiResourceStore({ accountLifetime: input.lifetime, client: {
        async readResource(resource, options) {
            const discussionId = await discussionIdFor(resource);
            const result = await (await repository()).readSummaryObservation(discussionId, options?.signal);
            if (result.kind !== 'succeeded') {
                const code = result.kind === 'failed' ? result.errorCode : result.kind;
                throw Object.assign(new Error(code), {
                    code: code === 'discussion_not_found' ? 'plugin_resource_not_found' : code,
                    retryable: false,
                });
            }
            const bytes = new TextEncoder().encode(JSON.stringify(result.value));
            return { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
        },
        async watchResource(resource, listener, options) {
            const discussionId = await discussionIdFor(resource);
            const owner = await repository();
            const unmount = owner.mount({ discussionId, projection: 'summary' });
            const unwatch = owner.subscribeSummaryObservation(discussionId, () => {
                if (input.lifetime.isCurrent()) listener({ kind: 'invalidated' });
            });
            const dispose = () => {
                unwatch();
                unmount();
                options?.signal?.removeEventListener('abort', dispose);
            };
            options?.signal?.addEventListener('abort', dispose, { once: true });
            if (options?.signal?.aborted) dispose();
            return { dispose };
        },
    } });
}
