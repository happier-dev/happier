import type { CapabilitiesDetectRequest, CapabilityDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { createMachineUpdateFactsCacheInputKey, MACHINE_UPDATE_FACTS_CACHE_SALT } from '@/updates/machineUpdateFacts';
import { LATEST_VERSION_CHECK_FRESH_MS } from '@/updates/latestVersionCheckFreshness';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import { getAgentResumeExperimentsFromSettings, getNewSessionRelevantInstallableDepKeys } from '@/agents/catalog/catalog';
import type { AgentPluginSettingsSnapshot } from '@/agents/registry/registryUiBehavior';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { getInstallablesRegistryEntries } from './installablesRegistry';
import { planInstallablesBackgroundActions } from './installablesBackgroundPlan';
import { buildMachineUpdateFactsRequest } from './requests';

type MachineCapabilitiesSnapshotLike = ReturnType<typeof getMachineCapabilitiesSnapshot>;

type Deps = Readonly<{
    getMachineCapabilitiesSnapshot: (machineId: string, serverId?: string | null) => MachineCapabilitiesSnapshotLike;
    prefetchMachineCapabilities: typeof prefetchMachineCapabilities;
    machineCapabilitiesInvoke: typeof machineCapabilitiesInvoke;
    loadDaemonMergedProjectionInputs: typeof loadDaemonMergedProjectionInputs;
}>;

const BACKGROUND_INVOKE_SUCCESS_COOLDOWN_MS = 10 * 60_000;
const BACKGROUND_INVOKE_IN_FLIGHT_TTL_MS = 5 * 60_000;
const BACKGROUND_ACTION_CACHE_MAX_ENTRIES = 200;

// Keyed by (machineId, serverId, installableKey, request fingerprint).
// Values represent a "blocked until" timestamp (ms). `Infinity` means an invoke is currently in-flight.
const blockedActionUntilMsByKey = new Map<string, number>();

function pruneBlockedActions(nowMs: number): void {
    for (const [actionKey, blockedUntilMs] of blockedActionUntilMsByKey) {
        if (blockedUntilMs <= nowMs) {
            blockedActionUntilMsByKey.delete(actionKey);
        }
    }

    while (blockedActionUntilMsByKey.size > BACKGROUND_ACTION_CACHE_MAX_ENTRIES) {
        const oldestKey = blockedActionUntilMsByKey.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        blockedActionUntilMsByKey.delete(oldestKey);
    }
}

function isActionBlocked(actionKey: string, nowMs: number): boolean {
    pruneBlockedActions(nowMs);
    const blockedUntilMs = blockedActionUntilMsByKey.get(actionKey);
    if (blockedUntilMs == null) return false;
    if (blockedUntilMs > nowMs) return true;
    blockedActionUntilMsByKey.delete(actionKey);
    return false;
}

function readResultsFromSnapshot(snapshot: MachineCapabilitiesSnapshotLike): Partial<Record<CapabilityId, CapabilityDetectResult>> | null {
    return snapshot?.response?.results ?? null;
}

function buildDetectRequestsForInstallables(capabilityIds: readonly CapabilityId[]): { requests: Array<{ id: CapabilityId }> } {
    return { requests: capabilityIds.map((id) => ({ id })) };
}

function normalizeActionKeyValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => normalizeActionKeyValue(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, normalizeActionKeyValue(nested)]),
        );
    }
    return value;
}

export function buildInstallablesBackgroundActionKey(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    installableKey: string;
    request: CapabilitiesInvokeRequest;
}>): string {
    return JSON.stringify([
        params.machineId,
        params.serverId ?? null,
        params.installableKey,
        params.request.id,
        params.request.method,
        normalizeActionKeyValue(params.request.params ?? null),
    ]);
}

type AgentInstallablesBackgroundOptions = Readonly<{
    agentId: string;
    machineId: string;
    serverId?: string | null;
    settings: Settings;
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    resumeSessionId: string | null;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime;
}>;

export async function ensureAgentInstallablesBackground(
    opts: AgentInstallablesBackgroundOptions,
    depsOverrides: Partial<Deps> = {},
): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const retirement = opts.accountLifetime?.onRetire(abort);
    try {
        if (opts.signal?.aborted || (opts.accountLifetime && !opts.accountLifetime.isCurrent())) return;
        await collectAgentInstallables({ ...opts, signal: controller.signal }, depsOverrides);
    } finally {
        opts.signal?.removeEventListener('abort', abort);
        retirement?.dispose();
    }
}

async function collectAgentInstallables(
    opts: AgentInstallablesBackgroundOptions & Readonly<{ signal: AbortSignal }>,
    depsOverrides: Partial<Deps> = {},
): Promise<void> {
    const deps: Deps = {
        getMachineCapabilitiesSnapshot: depsOverrides.getMachineCapabilitiesSnapshot ?? getMachineCapabilitiesSnapshot,
        prefetchMachineCapabilities: depsOverrides.prefetchMachineCapabilities ?? prefetchMachineCapabilities,
        machineCapabilitiesInvoke: depsOverrides.machineCapabilitiesInvoke ?? machineCapabilitiesInvoke,
        loadDaemonMergedProjectionInputs: depsOverrides.loadDaemonMergedProjectionInputs ?? loadDaemonMergedProjectionInputs,
    };

    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings, opts.machineId, opts.pluginSettings);
    const relevantKeys = getNewSessionRelevantInstallableDepKeys({
        agentId: opts.agentId,
        settings: opts.settings,
        pluginSettings: opts.pluginSettings,
        experiments,
        resumeSessionId: opts.resumeSessionId ?? '',
        // An installed Agent's descriptor is a per-machine fact, and this whole
        // routine is scoped to one machine, so its dependency set is read from
        // that machine's declaration rather than from whichever machine an
        // unscoped read happens to answer with.
        machineId: opts.machineId,
    });
    if (relevantKeys.length === 0) return;

    let entries = getInstallablesRegistryEntries().filter((entry) => relevantKeys.includes(entry.key));
    if (entries.length < relevantKeys.length) {
        try {
            const projectionInputs = await deps.loadDaemonMergedProjectionInputs({
                machineId: opts.machineId,
                serverId: opts.serverId,
                signal: opts.signal,
                accountLifetime: opts.accountLifetime,
                // Installables read only managed dependency declarations.
                sections: ['familiesById.managedDependencies'],
            });
            if (projectionInputs?.pluginProjectionV2) {
                entries = getInstallablesRegistryEntries({
                    pluginProjection: projectionInputs.pluginProjectionV2,
                }).filter((entry) => relevantKeys.includes(entry.key));
            }
        } catch {
            // Best-effort compatibility with older daemons or temporarily unavailable projections.
        }
    }
    if (opts.signal.aborted) return;
    if (entries.length === 0) return;

    const readResults = () => readResultsFromSnapshot(deps.getMachineCapabilitiesSnapshot(opts.machineId, opts.serverId));

    // 1) Ensure base dep status is present (planner is fail-closed on null status).
    let results = readResults();
    const missingBase = entries.filter((entry) => entry.getStatus(results) === null);
    if (missingBase.length > 0) {
        try {
            await deps.prefetchMachineCapabilities({
                machineId: opts.machineId,
                serverId: opts.serverId,
                request: buildDetectRequestsForInstallables(missingBase.map((e) => e.capabilityId)),
                timeoutMs: 12_000,
                signal: opts.signal,
            });
        } catch {
            // Best-effort: if base dep status cannot be fetched, skip planning installs/upgrades.
            return;
        }
        results = readResults();
    }
    if (opts.signal.aborted) return;

    // 2) Prefetch latest-version details when stale/missing (used for update decisions).
    const latestVersionRequests: CapabilityDetectRequest[] = entries
        .filter((entry) =>
            entry.shouldPrefetchLatestVersion({
                requireExistingResult: true,
                result: entry.getDetectResult(results),
                data: entry.getStatus(results),
            }),
        )
        .flatMap((entry) => entry.buildLatestVersionDetectRequest().requests ?? []) as CapabilityDetectRequest[];

    if (latestVersionRequests.length > 0) {
        try {
            await deps.prefetchMachineCapabilities({
                machineId: opts.machineId,
                serverId: opts.serverId,
                request: { requests: latestVersionRequests },
                timeoutMs: 12_000,
                signal: opts.signal,
            });
        } catch {
            // Best-effort: updates will be skipped if latest-version data is unavailable.
        }
        results = readResults();
    }
    if (opts.signal.aborted) return;

    // 3) Plan and invoke installs/upgrades (best-effort, non-blocking for callers).
    const planned = planInstallablesBackgroundActions({
        installables: entries.map((entry) => ({
            entry,
            status: entry.getStatus(results),
            policy: resolveInstallablePolicy({
                settings: opts.settings,
                machineId: opts.machineId,
                installableKey: entry.key,
                defaults: entry.defaultPolicy,
            }),
        })),
    });

    for (const action of planned) {
        if (opts.signal.aborted) return;
        const nowMs = Date.now();
        const actionKey = buildInstallablesBackgroundActionKey({
            machineId: opts.machineId,
            serverId: opts.serverId,
            installableKey: action.installableKey,
            request: action.request,
        });
        if (isActionBlocked(actionKey, nowMs)) continue;
        blockedActionUntilMsByKey.set(actionKey, nowMs + BACKGROUND_INVOKE_IN_FLIGHT_TTL_MS);
        pruneBlockedActions(nowMs);

        let invokeResult: Awaited<ReturnType<typeof deps.machineCapabilitiesInvoke>> | null = null;
        try {
            invokeResult = await deps.machineCapabilitiesInvoke(opts.machineId, action.request, {
                serverId: opts.serverId, timeoutMs: 5 * 60_000, signal: opts.signal,
                ...(opts.accountLifetime ? { accountId: opts.accountLifetime.scope.accountId } : {}),
            });
        } catch {
            // Best-effort: avoid surfacing errors for background installs/updates.
            // Important: if the invoke failed, do not permanently suppress retries.
            blockedActionUntilMsByKey.delete(actionKey);
            continue;
        }

        if (!invokeResult || invokeResult.supported !== true) {
            blockedActionUntilMsByKey.delete(actionKey);
            continue;
        }

        if (invokeResult.response.ok !== true) {
            // Best-effort: unsuccessful responses should not permanently suppress retries
            // (e.g. transient installer issues, policy changes, daemon upgrades).
            blockedActionUntilMsByKey.delete(actionKey);
            continue;
        }

        blockedActionUntilMsByKey.set(actionKey, Date.now() + BACKGROUND_INVOKE_SUCCESS_COOLDOWN_MS);

        if (opts.signal.aborted) return;
        try {
            await deps.prefetchMachineCapabilities({
                machineId: opts.machineId,
                serverId: opts.serverId,
                request: buildDetectRequestsForInstallables([action.request.id]),
                timeoutMs: 12_000,
                signal: opts.signal,
            });
        } catch {
            // Best-effort: capabilities refresh can fail without breaking the flow.
        }
    }
}

/**
 * R13 (e) — the update facts of every installed agent CLI and helper on these machines, so the
 * Updates summary covers tools nobody has opened a session with. One request per machine through
 * the capability cache's own freshness (`LATEST_VERSION_CHECK_FRESH_MS`, plus "an Updates request
 * is unmet while a K6 daemon's answer lacks the latest version"); nothing re-asks on a timer.
 * The Updates surface asks through here too, so there is one collector.
 */
export async function ensureMachineUpdateFactsBackground(
    opts: Readonly<{ machineIds: readonly string[]; serverId?: string | null; signal?: AbortSignal; accountLifetime?: ServerAccountScopeLifetime }>,
    depsOverrides: Partial<Readonly<{ prefetchMachineCapabilitiesIfStale: typeof prefetchMachineCapabilitiesIfStale }>> = {},
): Promise<void> {
    if (opts.signal?.aborted) return;
    const prefetch = depsOverrides.prefetchMachineCapabilitiesIfStale ?? prefetchMachineCapabilitiesIfStale;
    const request = buildMachineUpdateFactsRequest();
    await Promise.all(opts.machineIds.map((machineId) => prefetch({
        machineId,
        serverId: opts.serverId,
        accountLifetime: opts.accountLifetime,
        cacheKeySalt: MACHINE_UPDATE_FACTS_CACHE_SALT,
        cacheInputKey: createMachineUpdateFactsCacheInputKey({ machineId, serverId: opts.serverId, accountId: opts.accountLifetime?.scope.accountId }),
        staleMs: LATEST_VERSION_CHECK_FRESH_MS,
        request,
        signal: opts.signal,
    }).catch((error: unknown) => {
        // Best-effort like every background step here: the row keeps its last answer, and the
        // summary says "not checked" for a machine that has none.
        console.warn('Failed to refresh update facts for a machine:', error);
    })));
}
