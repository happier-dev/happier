import type { CapabilityDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { CapabilitiesInvokeRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import { getAgentResumeExperimentsFromSettings, getNewSessionRelevantInstallableDepKeys, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';

import { getInstallablesRegistryEntries } from './installablesRegistry';
import { planInstallablesBackgroundActions } from './installablesBackgroundPlan';

type MachineCapabilitiesSnapshotLike = ReturnType<typeof getMachineCapabilitiesSnapshot>;

type Deps = Readonly<{
    getMachineCapabilitiesSnapshot: (machineId: string, serverId?: string | null) => MachineCapabilitiesSnapshotLike;
    prefetchMachineCapabilities: typeof prefetchMachineCapabilities;
    machineCapabilitiesInvoke: typeof machineCapabilitiesInvoke;
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

export async function ensureAgentInstallablesBackground(
    opts: Readonly<{
        agentId: AgentId;
        machineId: string;
        serverId?: string | null;
        settings: Settings;
        resumeSessionId: string | null;
    }>,
    depsOverrides: Partial<Deps> = {},
): Promise<void> {
    const deps: Deps = {
        getMachineCapabilitiesSnapshot: depsOverrides.getMachineCapabilitiesSnapshot ?? getMachineCapabilitiesSnapshot,
        prefetchMachineCapabilities: depsOverrides.prefetchMachineCapabilities ?? prefetchMachineCapabilities,
        machineCapabilitiesInvoke: depsOverrides.machineCapabilitiesInvoke ?? machineCapabilitiesInvoke,
    };

    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    const relevantKeys = getNewSessionRelevantInstallableDepKeys({
        agentId: opts.agentId,
        settings: opts.settings,
        experiments,
        resumeSessionId: opts.resumeSessionId ?? '',
    });
    if (relevantKeys.length === 0) return;

    const entries = getInstallablesRegistryEntries().filter((e) => relevantKeys.includes(e.key));
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
            });
        } catch {
            // Best-effort: if base dep status cannot be fetched, skip planning installs/upgrades.
            return;
        }
        results = readResults();
    }

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
            });
        } catch {
            // Best-effort: updates will be skipped if latest-version data is unavailable.
        }
        results = readResults();
    }

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
            invokeResult = await deps.machineCapabilitiesInvoke(opts.machineId, action.request, { serverId: opts.serverId, timeoutMs: 5 * 60_000 });
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

        try {
            await deps.prefetchMachineCapabilities({
                machineId: opts.machineId,
                serverId: opts.serverId,
                request: buildDetectRequestsForInstallables([action.request.id]),
                timeoutMs: 12_000,
            });
        } catch {
            // Best-effort: capabilities refresh can fail without breaking the flow.
        }
    }
}
