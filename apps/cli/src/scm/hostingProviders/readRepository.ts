import {
    ScmCredentialFreeRepositorySelectorV1Schema,
    ScmHostingRepositoryGetResponseV1Schema,
    type ScmCredentialFreeRepositorySelectorV1,
    type ScmHostingRepositoryGetResponseV1,
} from '@happier-dev/protocol/scm/repositoryClone';
import { ScmHostingProviderRefSchema } from '@happier-dev/protocol/scm/pullRequests';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';
import type { HostingProviderResolvedRegistry } from '@happier-dev/plugin-sdk/scm/hosting';
import type { ResolvedScmHostingProviderRegistry } from './registry';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

/** Registry routing and the contributed getRepository own identity and visibility. */
export async function readScmHostingRepository(input: Readonly<{
    selector: ScmCredentialFreeRepositorySelectorV1;
    registry?: ResolvedScmHostingProviderRegistry;
    signal?: AbortSignal;
}>): Promise<ScmHostingRepositoryGetResponseV1> {
    const selector = ScmCredentialFreeRepositorySelectorV1Schema.parse(input.selector);
    const current = () => input.signal?.throwIfAborted();
    current();
    const read = async (registry: Pick<HostingProviderResolvedRegistry, 'getRepositoryPublishing' | 'detectRemote'>): Promise<ScmHostingRepositoryGetResponseV1> => {
        current();
        const capability = registry.getRepositoryPublishing(selector.provider.id);
        if (!capability) return { success: true, kind: 'unsupported' };
        // Re-resolve against contributed/configured routing instead of trusting a caller's
        // provider base or cached URLs as credential-selection authority.
        const detected = registry.detectRemote({ remoteName: null,
            remoteUrl: `${selector.provider.baseUrl.replace(/\/+$/, '')}/${selector.repository.nameWithOwner}` });
        if (detected.kind !== 'resolved' || detected.provider.id !== selector.provider.id
            || !detected.provider.nameWithOwner) return { success: true, kind: 'unknown' };
        const provider = ScmHostingProviderRefSchema.parse(detected.provider);
        const name = detected.provider.nameWithOwner;
        const separator = name.lastIndexOf('/');
        if (separator <= 0 || separator === name.length - 1) return { success: true, kind: 'unknown' };
        const repository = await capability.getRepository({ provider, owner: name.slice(0, separator),
            repositoryName: name.slice(separator + 1), ...(input.signal ? { signal: input.signal } : {}) });
        current();
        if (!repository) return { success: true, kind: 'unknown' };
        if (repository.visibility === 'private' || repository.visibility === 'internal') return { success: true, kind: 'private' };
        if (repository.visibility !== 'public') return { success: true, kind: 'unknown' };
        const publicResult = ScmHostingRepositoryGetResponseV1Schema.safeParse({ success: true, kind: 'public',
            repository: { label: repository.nameWithOwner, url: repository.webUrl } });
        return publicResult.success ? publicResult.data : { success: true, kind: 'unknown' };
    };
    try {
        if (input.registry) return await read(input.registry);
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({});
        try {
            await lease.registry.activateContributionsOnDemand((lease.registry.contributes.scmHostingProviders ?? []).flatMap(entry =>
                entry.pluginId ? [{ pluginId: entry.pluginId, family: 'scmHostingProviders' as const, localId: entry.definition.id }] : []));
            current();
            const services = createHostScmHostingProviderRuntimeServices(lease.registry);
            return await read(await services.resolveScmHostingProviderRegistry!());
        } finally { await lease.release(); }
    } catch (error) {
        current();
        return { success: false, kind: 'failed', code: 'repository_unavailable',
            failureCause: normalizeActionExecutorThrownError(error, 'scm.repository.read').failureCause };
    }
}
