import {
    ScmCredentialFreeRepositorySelectorV1Schema,
    type ScmHostingRepositoryResolveAddressResponseV1,
} from '@happier-dev/protocol/scm/repositoryClone';
import { parseScmRemoteUrl } from '@happier-dev/plugin-sdk/scm';
import { ScmHostingProviderRefSchema } from '@happier-dev/protocol/scm/pullRequests';
import type { HostingProviderResolvedRegistry } from '@happier-dev/plugin-sdk/scm/hosting';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';
import type { ResolvedScmHostingProviderRegistry } from './registry';

/** The same registry/plugin routing used by status snapshots; no repository or auth probe. */
export async function resolveScmHostingRepositoryAddress(input: Readonly<{
    address: string;
    registry?: ResolvedScmHostingProviderRegistry;
    signal?: AbortSignal;
}>): Promise<ScmHostingRepositoryResolveAddressResponseV1> {
    input.signal?.throwIfAborted();
    const address = input.address.trim();
    // The address field also accepts host/owner/repository. This adds its transport
    // spelling only; the provider contribution remains the repository identity owner.
    const shorthand = !address.includes('://') && !address.includes('@')
        && /^[^/\\\s?#]+\/[^/\\\s]+\/[^\\\s]+$/.test(address);
    const remoteUrl = shorthand ? `https://${address}` : address;
    if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(address)) return { success: true, kind: 'unsupported' };
    if (!ScmCredentialFreeRepositorySelectorV1Schema.shape.repository.shape.cloneUrl.safeParse(remoteUrl).success) {
        return { success: true, kind: 'invalid' };
    }
    const transport = parseScmRemoteUrl(remoteUrl);
    if (!transport) return { success: true, kind: 'unsupported' };
    const resolve = (registry: Pick<HostingProviderResolvedRegistry, 'detectRemote'>): ScmHostingRepositoryResolveAddressResponseV1 => {
        input.signal?.throwIfAborted();
        const detected = registry.detectRemote({ remoteName: null, remoteUrl });
        if (detected.kind !== 'resolved') return { success: true, kind: 'unknown' };
        const provider = ScmHostingProviderRefSchema.parse(detected.provider);
        if (!provider.nameWithOwner) return { success: true, kind: 'unsupported' };
        const protocol = transport.syntax === 'scp' || transport.protocol === 'ssh:' ? 'ssh' : 'https';
        const selector = ScmCredentialFreeRepositorySelectorV1Schema.safeParse({
            provider: { id: provider.id, kind: provider.kind, displayName: provider.displayName, baseUrl: provider.baseUrl },
            repository: { nameWithOwner: provider.nameWithOwner,
                ...(protocol === 'ssh' ? { sshUrl: remoteUrl } : { cloneUrl: remoteUrl }),
                ...(provider.repositoryWebUrl ? { webUrl: provider.repositoryWebUrl } : {}),
            }, protocol,
        });
        return selector.success ? { success: true, kind: 'resolved', selector: selector.data } : { success: true, kind: 'invalid' };
    };
    if (input.registry) return resolve(input.registry);
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({});
    try {
        // Only hosting routing is demanded, rather than every SCM backend.
        await lease.registry.activateContributionsOnDemand((lease.registry.contributes.scmHostingProviders ?? []).flatMap(entry =>
            entry.pluginId ? [{ pluginId: entry.pluginId, family: 'scmHostingProviders' as const, localId: entry.definition.id }] : []));
        input.signal?.throwIfAborted();
        const services = createHostScmHostingProviderRuntimeServices(lease.registry);
        const registry = await services.resolveScmHostingProviderRegistry!();
        return resolve(registry);
    } finally { await lease.release(); }
}
