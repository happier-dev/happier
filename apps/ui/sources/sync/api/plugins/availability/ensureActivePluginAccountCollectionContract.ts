import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { normalizePluginAccountCollectionContractsV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { sync } from '@/sync/sync';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';

type BootstrapRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    release?: () => Promise<void>;
}>;

export type PluginAccountCollectionContractBootstrapDependencies = Readonly<{
    captureRequestAuthority: (scope: ServerAccountScope) => Promise<BootstrapRequestAuthority>;
    refreshAvailability: (pluginId: string) => Promise<void>;
}>;

export type EnsureActivePluginAccountCollectionContractInput = Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    readAvailability: () => PluginAccountAvailabilityReader;
}> & (Readonly<{ ref: PluginCollectionContractRefV1; collectionId?: never }>
    | Readonly<{ ref?: never; collectionId: string }>);

export function createPluginAccountCollectionContractBootstrap(
    dependencies: PluginAccountCollectionContractBootstrapDependencies,
): (input: EnsureActivePluginAccountCollectionContractInput) => Promise<boolean> {
    // Only pending work is shared. Currentness and the admitted writer remain
    // facts read afresh from Availability, never a second retained claim store.
    const pending = new Map<string, Readonly<{ lifetime: ActiveServerAccountScopeLifetime; promise: Promise<boolean> }>>();
    const current = (input: EnsureActivePluginAccountCollectionContractInput) => input.accountLifetime.isCurrent()
        && !input.signal?.aborted && input.isCurrent?.() !== false;
    const admitted = (input: EnsureActivePluginAccountCollectionContractInput) => input.readAvailability().readCurrentCollectionContract({
        pluginId: input.pluginId, collectionId: input.ref?.collectionId ?? input.collectionId!,
        ...(input.ref ? { ref: input.ref } : {}),
    }).kind === 'available';
    return async input => {
        if (!current(input)) return false;
        if (admitted(input)) return true;
        const selected = await input.readAvailability().ensureCurrentAccountExecution(input.pluginId);
        if (!current(input)) return false;
        if (selected.kind !== 'available' || selected.release !== null || selected.sourceCustody.kind !== 'bundled_first_party'
            || selected.sourceCustody.packagedRuntime.kind !== 'source_declaration') return false;
        const contracts = normalizePluginAccountCollectionContractsV1({ pluginId: input.pluginId,
            contributions: selected.manifest.contributes.accountCollections });
        if (!contracts.some(ref => ref.collectionId === (input.ref?.collectionId ?? input.collectionId)
            && (!input.ref || (ref.schemaVersion === input.ref.schemaVersion
                && ref.contractDigest === input.ref.contractDigest && ref.pluginId === input.ref.pluginId)))) return false;
        const key = JSON.stringify([input.accountLifetime.scope.serverId, input.accountLifetime.scope.accountId, input.pluginId, selected.custodyId]);
        const incumbent = pending.get(key);
        let operation = incumbent?.lifetime === input.accountLifetime ? incumbent.promise : undefined;
        if (!operation) {
            operation = (async () => {
                const controller = new AbortController();
                const retirement = input.accountLifetime.onRetire(() => controller.abort());
                let authority: BootstrapRequestAuthority | null = null;
                try {
                    authority = await dependencies.captureRequestAuthority(input.accountLifetime.scope);
                    const selection = input.readAvailability().readCurrentAccountExecution(input.pluginId);
                    if (!input.accountLifetime.isCurrent() || selection.kind !== 'available' || selection.custodyId !== selected.custodyId) return false;
                    const response = await authority.request(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'], {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ manifest: selected.manifest }), signal: controller.signal,
                    });
                    if (!response.ok) return false;
                    const result = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.safeParse(await response.json());
                    if (!result.success || result.data.intent.pluginId !== input.pluginId || !input.accountLifetime.isCurrent()) return false;
                    // The server derives and publishes the writer. Only the incumbent
                    // sync refresh can make that result visible to Data admission.
                    await dependencies.refreshAvailability(input.pluginId);
                    return input.accountLifetime.isCurrent();
                } catch {
                    return false;
                } finally {
                    retirement.dispose();
                    await authority?.release?.();
                }
            })();
            pending.set(key, { lifetime: input.accountLifetime, promise: operation });
            const completed = operation;
            void completed.finally(() => { if (pending.get(key)?.promise === completed) pending.delete(key); }).catch(() => {});
        }
        const shared = operation;
        const signal = input.signal;
        if (!signal) return await shared && current(input) && admitted(input);
        return await new Promise<boolean>(resolve => {
            const abort = () => { signal.removeEventListener('abort', abort); resolve(false); };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            void shared.then(result => { signal.removeEventListener('abort', abort); resolve(result && current(input) && admitted(input)); }, abort);
        });
    };
}

export const ensureActivePluginAccountCollectionContract = createPluginAccountCollectionContractBootstrap({
    captureRequestAuthority: async scope => {
        const authority = await captureServerRequestAuthorityForServerAccountScope({ scope,
            activeRequest: (path, init) => apiSocket.request(path, init) });
        return { request: authority.request, release: authority.release };
    },
    refreshAvailability: async pluginId => { await sync.refreshPluginAccountAvailability([pluginId]); },
});
