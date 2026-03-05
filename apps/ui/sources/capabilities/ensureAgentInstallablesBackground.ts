import type { CapabilityDetectRequest, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { machineCapabilitiesInvoke } from '@/sync/ops';
import { getAgentResumeExperimentsFromSettings, getNewSessionRelevantInstallableDepKeys, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveInstallablePolicy } from '@/sync/domains/settings/installablesPolicy';

import { getInstallablesRegistryEntries } from './installablesRegistry';
import { planInstallablesBackgroundActions } from './installablesBackgroundPlan';
import { normalizeInstallSpecSettingValue } from './normalizeInstallSpecSettingValue';

type MachineCapabilitiesSnapshotLike = ReturnType<typeof getMachineCapabilitiesSnapshot>;

type Deps = Readonly<{
    getMachineCapabilitiesSnapshot: (machineId: string, serverId?: string | null) => MachineCapabilitiesSnapshotLike;
    prefetchMachineCapabilities: typeof prefetchMachineCapabilities;
    machineCapabilitiesInvoke: typeof machineCapabilitiesInvoke;
}>;

const BACKGROUND_INVOKE_SUCCESS_COOLDOWN_MS = 10 * 60_000;

// Keyed by (machineId, serverId, installableKey, method, installSpec).
// Values represent a "blocked until" timestamp (ms). `Infinity` means an invoke is currently in-flight.
const blockedActionUntilMsByKey = new Map<string, number>();

function isActionBlocked(actionKey: string, nowMs: number): boolean {
    const blockedUntilMs = blockedActionUntilMsByKey.get(actionKey);
    if (blockedUntilMs == null) return false;
    if (blockedUntilMs === Number.POSITIVE_INFINITY) return true;
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

export async function ensureAgentInstallablesBackground(
    opts: Readonly<{
        agentId: AgentId;
        machineId: string;
        serverId?: string | null;
        settings: Settings;
        resumeSessionId: string;
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
        experiments,
        resumeSessionId: opts.resumeSessionId,
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

    // 2) Prefetch registry details when stale/missing (used for update decisions).
    const registryRequests: CapabilityDetectRequest[] = entries
        .filter((entry) =>
            entry.shouldPrefetchRegistry({
                requireExistingResult: true,
                result: entry.getDetectResult(results),
                data: entry.getStatus(results),
            }),
        )
        .flatMap((entry) => entry.buildRegistryDetectRequest().requests ?? []) as CapabilityDetectRequest[];

    if (registryRequests.length > 0) {
        try {
            await deps.prefetchMachineCapabilities({
                machineId: opts.machineId,
                serverId: opts.serverId,
                request: { requests: registryRequests },
                timeoutMs: 12_000,
            });
        } catch {
            // Best-effort: updates will be skipped if registry data is unavailable.
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
            installSpec: (() => {
                const raw = opts.settings[entry.installSpecSettingKey];
                return normalizeInstallSpecSettingValue(raw);
            })(),
        })),
    });

    for (const action of planned) {
        const nowMs = Date.now();
        const installSpec = (() => {
            const params = (action.request as { params?: unknown }).params;
            if (!params || typeof params !== 'object') return null;
            const raw = (params as { installSpec?: unknown }).installSpec;
            return typeof raw === 'string' ? raw : null;
        })();
        const actionKey = JSON.stringify([
            opts.machineId,
            opts.serverId ?? null,
            action.installableKey,
            action.request.id,
            action.request.method,
            installSpec,
        ]);
        if (isActionBlocked(actionKey, nowMs)) continue;
        blockedActionUntilMsByKey.set(actionKey, Number.POSITIVE_INFINITY);

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
