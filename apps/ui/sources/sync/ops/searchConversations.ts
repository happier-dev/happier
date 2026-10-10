import { isMemorySessionSearchHitV1, type MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveExternalSessionsSourceKeyForDeclaration } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { ensureSessionMetadataInventoryForServerAccountScope } from '@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { listExternalSessionBrowseProviderIds, resolveExternalSessionBrowseSourceOptions,
    resolveExternalSessionBrowseContentSearchSupported } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';
import { authorizeMemorySearchResult, captureMemorySearchSessionReadAuthority,
    readMemorySearchSessionForServerScope, readMemorySearchSessionHydrationConcurrencyLimit } from '@/sync/domains/memory/hydrateMemorySearchSessionTargets';
import { searchConversations, type ConversationSearchSource, type ConversationSearchResult } from '@/sync/domains/search/searchConversations';

/** Reuses History's projected/configured source owner, including connected-account variants. */
export async function readConversationSearchSources(input: Readonly<{
    machineId: string; accountLifetime: ServerAccountScopeLifetime; signal?: AbortSignal;
}>): Promise<readonly ConversationSearchSource[]> {
    const { serverId, accountId } = input.accountLifetime.scope;
    input.signal?.throwIfAborted();
    if (!input.accountLifetime.isCurrent()) return [];
    const inputs = await loadDaemonMergedProjectionInputs({ machineId: input.machineId, serverId, accountLifetime: input.accountLifetime });
    input.signal?.throwIfAborted();
    const projection = inputs?.pluginProjectionV2;
    if (!projection || !input.accountLifetime.isCurrent()) return [];
    let authority: Awaited<ReturnType<typeof captureMemorySearchSessionReadAuthority>> | null = null;
    try {
        const state = storage.getState();
        const requiresConnectedProfile = Object.values(projection.agentsById).some(agent =>
            agent.externalSessions?.sources.some(source => source.instances?.some(instance => instance.kind === 'connectedServiceProfiles')));
        let profile = areServerAccountScopesEqual(state.profileScope, input.accountLifetime.scope) ? state.profile : null;
        if (!profile && requiresConnectedProfile) {
            authority = await captureMemorySearchSessionReadAuthority({ serverId, accountId });
            const response = await authority.request('/v1/profile', { signal: input.signal });
            if (!response.ok) throw new Error('Conversation sources are unavailable');
            const exactProfile = AccountProfileSchema.parse(await response.json());
            if (exactProfile.id !== accountId) throw new Error('Conversation sources Account changed');
            profile = exactProfile;
        }
        input.signal?.throwIfAborted();
        if (!input.accountLifetime.isCurrent()) return [];
        return listExternalSessionBrowseProviderIds({ accountScope: input.accountLifetime.scope, machineId: input.machineId, projection })
            .flatMap(agentId => resolveExternalSessionBrowseSourceOptions({ accountScope: input.accountLifetime.scope,
                machineId: input.machineId, providerId: agentId, projection, profile, labelsByKey: {}, activeServerId: serverId,
                agentSettings: readAccountSettingsForScope({ scope: input.accountLifetime.scope,
                    focusedScope: state.settingsScope, focusedSettings: state.settings }),
            }).flatMap(option => {
                const declaration = projection.agentsById[agentId]?.externalSessions?.sources.find(source => source.sourceKind === option.source.kind);
                return declaration ? [{ agentId, source: option.source,
                    key: option.key, label: option.label, ...(option.detail ? { detail: option.detail } : {}),
                    sourceKey: resolveExternalSessionsSourceKeyForDeclaration(declaration, option.source),
                    contentSearch: resolveExternalSessionBrowseContentSearchSupported({ providerId: agentId, source: option.source, projection }) }] : [];
            }));
    } finally { await authority?.release(); }
}

/** One exact Account-bound operation shared by the palette, History hooks and mounted Actions. */
export async function searchConversationsForAccount(input: Readonly<{
    query: MemorySearchQueryV1;
    machineIds?: readonly string[];
    mode?: 'auto' | 'indexed' | 'standard';
    accountLifetime: ServerAccountScopeLifetime;
    providers: Readonly<{ homeSessions: boolean; daemonEnabled: boolean }>;
    source?: ConversationSearchSource;
    includeThreads?: boolean;
    signal?: AbortSignal;
    continuation?: NonNullable<ConversationSearchResult['continuations']>[number];
    onSources?: (sources: NonNullable<ConversationSearchResult['sources']>) => void;
}>): Promise<ConversationSearchResult> {
    const { serverId, accountId } = input.accountLifetime.scope;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted || !input.accountLifetime.isCurrent()) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const retirement = input.accountLifetime.onRetire(abort);
    let authority: Awaited<ReturnType<typeof captureMemorySearchSessionReadAuthority>> | null = null;
    try {
        controller.signal.throwIfAborted();
        let inventory: readonly Readonly<{ id: string; active: boolean; activeAt?: number }>[] =
            resolveVisibleMachinesForActiveServerFromState(storage.getState(), { serverId });
        if (inventory.length === 0 && input.machineIds?.length !== 0 && input.query.query.trim()
            && (input.providers.daemonEnabled || input.mode === 'standard' || input.mode === 'auto')) {
            authority = await captureMemorySearchSessionReadAuthority({ serverId, accountId });
            controller.signal.throwIfAborted();
            const credentials = authority.context.credentials;
            if (!credentials) throw new Error('Conversation machine inventory credentials are unavailable');
            inventory = (await fetchMachineRows({ credentials,
                request: (path, init) => authority!.request(path, { ...init, signal: controller.signal }),
            })).filter(isMachineVisibleForSelection);
            controller.signal.throwIfAborted();
        }
        const machines = input.machineIds === undefined ? inventory : [...new Set(input.machineIds)]
            .map(id => inventory.find(machine => machine.id === id) ?? { id, active: false });
        let query = input.query;
        const homeSessions = input.providers.homeSessions && input.machineIds?.length !== 0;
        if (homeSessions && input.machineIds && query.query.trim() && (!query.corpora || query.corpora.includes('sessions'))) {
            await ensureSessionMetadataInventoryForServerAccountScope({ scope: input.accountLifetime.scope,
                accountLifetime: input.accountLifetime, signal: controller.signal });
            controller.signal.throwIfAborted();
            const ids = new Set(input.machineIds);
            const eligibleSessionIds = Object.values(readSessionListRowsForServerId(storage.getState().sessionListRowsByServerId, serverId) ?? {})
                .filter(row => typeof row.metadata?.machineId === 'string' && ids.has(row.metadata.machineId))
                .map(row => row.id).filter(id => !query.eligibleSessionIds || query.eligibleSessionIds.includes(id));
            query = { ...query, eligibleSessionIds };
        }
        const result = await searchConversations({ serverId, accountId, query,
            machines: machines.map(machine => ({ id: machine.id, online: isMachineOnline(machine) })),
            concurrencyLimit: readMemorySearchSessionHydrationConcurrencyLimit(),
            mode: input.mode, ...input.providers, homeSessions, signal: controller.signal,
            continuation: input.continuation,
            includeThreads: input.includeThreads,
            onSources: input.onSources,
            readSources: machineId => input.source ? Promise.resolve([input.source])
                : readConversationSearchSources({ machineId, accountLifetime: input.accountLifetime, signal: controller.signal }),
            authorize: async rows => {
                const indexed = rows.filter(row => row.mode === 'indexed');
                // Native/document rows already crossed the exact Account-bound machine
                // RPC. Only Happier Sessions require the additional HTTP visibility read.
                if (!indexed.some(row => isMemorySessionSearchHitV1(row.hit))) {
                    controller.signal.throwIfAborted();
                    return input.accountLifetime.isCurrent() ? rows : [];
                }
                authority ??= await captureMemorySearchSessionReadAuthority({ serverId, accountId });
                const authorized = await authorizeMemorySearchResult({ result: { v: 1, ok: true, hits: indexed.map(row => row.hit) },
                    serverId, accountId, authority: authority!, accountLifetime: input.accountLifetime,
                    readSessionForServerScope: readMemorySearchSessionForServerScope,
                    concurrencyLimit: readMemorySearchSessionHydrationConcurrencyLimit(), signal: controller.signal });
                controller.signal.throwIfAborted();
                const allowed = new Set(authorized.ok ? authorized.hits : []);
                return rows.filter(row => row.mode !== 'indexed' || allowed.has(row.hit));
            },
        });
        controller.signal.throwIfAborted();
        return result;
    } finally {
        retirement.dispose();
        input.signal?.removeEventListener('abort', abort);
        await authority?.release();
    }
}
