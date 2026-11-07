import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { PluginUiHostReadReferenceV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { retainManagedMachineInventory, type ManagedMachineInventoryEntry } from '@/components/settings/machines/managed/useManagedMachineInventory';

/** Resource presentation borrows the incumbent inventory; it never runs a second list request or Home observer. */
export function createPluginManagedMachineInventoryHostReadStore(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
}>): PluginUiResourceStore {
    const assertReference = (resource: Parameters<PluginUiResourceStore['getEntry']>[0]) => {
        const reference = PluginUiHostReadReferenceV1Schema.parse(resource);
        const serverId = resolveServerProfileScopeIdForIdentifier(input.lifetime.scope.serverId) || input.lifetime.scope.serverId;
        if (reference.hostRead !== 'machines.managed.list' || !input.lifetime.isCurrent()
            || reference.input.homeId !== getServerProfileById(serverId)?.serverIdentityId) {
            throw Object.assign(new Error('Managed inventory Account is unavailable'), { code: 'plugin_resource_unavailable', retryable: false });
        }
    };
    const readInventory = (signal?: AbortSignal): Promise<ManagedMachineInventoryEntry> => {
        let held: ReturnType<typeof retainManagedMachineInventory> | undefined;
        let retirement: ReturnType<ServerAccountScopeLifetime['onRetire']> | undefined;
        let abort = () => {};
        const result = new Promise<ManagedMachineInventoryEntry>((resolve, reject) => {
            abort = () => reject(Object.assign(new Error('Managed inventory read retired'), { code: 'plugin_resource_aborted', retryable: false }));
            signal?.addEventListener('abort', abort, { once: true });
            retirement = input.lifetime.onRetire(abort);
            if (signal?.aborted || !input.lifetime.isCurrent()) { abort(); return; }
            held = retainManagedMachineInventory(input.lifetime, entry => {
                if (signal?.aborted || !input.lifetime.isCurrent()) { abort(); return; }
                if (entry.status === 'ready') resolve(entry);
                else if (entry.status !== 'loading') reject(Object.assign(new Error(entry.errorCode ?? 'managed_request_failed'), {
                    code: entry.errorCode ?? 'managed_request_failed', retryable: false,
                }));
            });
        });
        return result.finally(() => { signal?.removeEventListener('abort', abort); retirement?.dispose(); held?.dispose(); });
    };
    const store = createPluginUiResourceStore({ accountLifetime: input.lifetime, client: {
        async readResource(resource, options) {
            assertReference(resource);
            const entry = await readInventory(options?.signal);
            const bytes = new TextEncoder().encode(JSON.stringify({ machines: entry.machines }));
            return { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
        },
        async watchResource(resource, listener, options) {
            assertReference(resource);
            // The immediate subscription receipt is its baseline, not a changed fact.
            let establishing = true;
            const held = retainManagedMachineInventory(input.lifetime, () => {
                if (!establishing && !options?.signal?.aborted && input.lifetime.isCurrent()) listener({ kind: 'invalidated' });
            });
            establishing = false;
            const dispose = () => { held.dispose(); options?.signal?.removeEventListener('abort', dispose); };
            options?.signal?.addEventListener('abort', dispose, { once: true });
            if (options?.signal?.aborted) dispose();
            return { dispose };
        },
    } });
    return Object.freeze({
        getEntry(resource) {
            const entry = store.getEntry(resource);
            // Only explicit Retry requests a fresh inventory read. Invalidation reads
            // consume the already-applied receipt, so both entry points share its IO.
            const refresh = async () => {
                assertReference(resource);
                const held = retainManagedMachineInventory(input.lifetime, () => {});
                try { await held.refresh(); return await entry.refresh(); }
                finally { held.dispose(); }
            };
            return Object.freeze({ ...entry, refresh,
                select(projection, selector) {
                    const selected = entry.select(projection, selector);
                    return Object.freeze({ ...selected, refresh: async () => { await refresh(); } });
                },
            });
        },
        dispose: store.dispose,
    } satisfies PluginUiResourceStore);
}
