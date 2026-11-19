import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveBundledAgentIdFromContributionIdentity } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { isMachineAgentExecutionStateBlockingV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { formatMachineAgentExecutionState } from '@/components/machines/agents/machineAgentCopy';
import type { ReviewEngineListItem } from '@happier-dev/protocol/reviews/reviewEngines';

import {
    getResolvedBackendCatalogEntries,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import {
    LEGACY_COMPAT_PRIMARY_AGENT_ID,
} from '@/agents/backendCatalog/legacyCompatAgents';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveReviewEngineTarget, type ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';
import { resolveExecutionRunAvailableBackends } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import { findMachineAgentForBackendTargetKey } from '@/agents/machineAgents/machineAgentCatalog';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { resolveMachineAgentSetupRow, type MachineAgentSetupRow } from '@/components/sessions/agentPicker/machineAgentSetupRow';

export type ExecutionRunLauncherBackendChoice = Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    targetKey: string;
    backendId: string;
    /** Exact id admitted by the review inventory; configured engines retain their Agent target. */
    reviewEngineId?: string;
    reviewInventoryItem?: ReviewEngineListItem;
    /** Operational Agent identity that owns this selected backend. */
    agentId: string;
    title: string;
    disabled: boolean;
    /** The daemon inventory's prerequisite reason, even without a MachineAgent setup descriptor. */
    unavailableReason?: string;
    /**
     * The Machine's own inventory says this Agent is not ready there: the shared Agent-picker rule
     * presents it placed and opening setup. It is never a fresh choice, but a saved one stays chosen.
     */
    setup?: MachineAgentSetupRow;
}>;

/** A choice a person (or a default) may newly pick: run-capable here and ready on the Machine. */
export function isFreshExecutionRunBackendChoice(choice: ExecutionRunLauncherBackendChoice): boolean {
    return choice.disabled !== true && choice.setup === undefined;
}

export function resolveInitialExecutionRunBackendTargetKey(
    initialTarget: PersistedBackendTargetRefV2 | null,
    choices: readonly ExecutionRunLauncherBackendChoice[],
): string | null {
    if (!initialTarget) return null;
    const canonicalTargetKey = buildBackendTargetKeyV2(initialTarget);
    return choices.find((choice) => (
        isFreshExecutionRunBackendChoice(choice)
        && buildBackendTargetKeyV2(choice.backendTarget) === canonicalTargetKey
    ))?.targetKey ?? null;
}

type ResolvedBackendCatalogEntry = ReturnType<typeof getResolvedBackendCatalogEntries>[number];

function collapseConfiguredAcpBackendCollisions(
    entries: readonly ResolvedBackendCatalogEntry[],
): readonly ResolvedBackendCatalogEntry[] {
    const configuredAcpBackendIds = new Set(
        entries
            .filter((entry) => entry.kind === 'configuredBackend')
            .map((entry) => entry.backendId)
            .filter((backendId): backendId is string => typeof backendId === 'string' && backendId.length > 0),
    );

    if (configuredAcpBackendIds.size === 0) {
        return entries;
    }

    return entries.filter((entry) => {
        if (entry.kind === 'configuredBackend') {
            return true;
        }
        return !configuredAcpBackendIds.has(entry.backendId ?? '');
    });
}

function isCanonicalCatalogBackendId(value: string): boolean {
    return value.length > 0 && value !== LEGACY_COMPAT_PRIMARY_AGENT_ID && !readLegacyConfiguredAcpBackendId(value)
        && !BackendTargetKeyV2Schema.safeParse(value).success;
}

function hasLegacyCompatExecutionRunAvailabilityCarrier(
    availableBackendIds: ReadonlySet<string>,
    configuredBackendId?: string | null,
): boolean {
    if (availableBackendIds.has(LEGACY_COMPAT_PRIMARY_AGENT_ID)) {
        return true;
    }
    if (!configuredBackendId) {
        return false;
    }
    return Array.from(availableBackendIds).some((backendId) => readLegacyConfiguredAcpBackendId(backendId) === configuredBackendId);
}

type ResolveBackendChoicesParams = Readonly<{
    enabledAgentIds: readonly string[];
    executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
    reviewEngines?: readonly ReviewEngineListItem[];
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    intent: string;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    /** The Machine's own Agent inventory, once it has answered. */
    machineAgents?: readonly MachineAgent[] | null;
}>;

/**
 * A choice is not offered while the Machine has not told us what it offers (an unread Machine says
 * neither yes nor no). An Agent its inventory says is not ready there follows the one Agent-picker
 * rule (`resolveMachineAgentSetupRow`), so every picker names the same Agents the same way.
 */
function applyMachineFacts(
    choices: readonly ExecutionRunLauncherBackendChoice[],
    params: Pick<ResolveBackendChoicesParams, 'executionRunsBackends' | 'machineAgents'>,
): readonly ExecutionRunLauncherBackendChoice[] {
    const unread = params.executionRunsBackends == null;
    return choices.map((choice) => {
        const setup = resolveMachineAgentSetupRow(findMachineAgentForBackendTargetKey(params.machineAgents ?? [], choice.targetKey));
        return {
            ...choice,
            disabled: choice.disabled || unread,
            ...(setup ? { setup } : {}),
        };
    });
}

export function resolveExecutionRunLauncherBackendChoices(params: ResolveBackendChoicesParams): readonly ExecutionRunLauncherBackendChoice[] {
    if (params.intent === 'review') {
        return (params.reviewEngines ?? []).map((item) => {
            const backendTarget = resolveReviewEngineTarget(item.value ?? item.engineId);
            const targetKey = resolveBackendTargetKeyV2(backendTarget);
            const canonicalTarget = parseBackendTargetKeyV2(targetKey);
            const backendId = item.backendId ?? (backendTarget.kind === 'backend'
                ? backendTarget.backendId : backendTarget.definitionId ?? item.engineId);
            const agentId = canonicalTarget.kind === 'agent'
                ? resolveBundledAgentIdFromContributionIdentity(canonicalTarget.identity) ?? buildQualifiedPluginContributionKey(canonicalTarget.identity)
                : params.mergedBackendProjectionById?.[backendId]?.agentId ?? backendId;
            // Setup supplies the shared picker action. The daemon Review inventory owns availability.
            const setup = item.enabled ? undefined : resolveMachineAgentSetupRow(
                findMachineAgentForBackendTargetKey(params.machineAgents ?? [], targetKey),
            );
            return {
                reviewEngineId: item.engineId,
                reviewInventoryItem: item,
                backendTarget,
                targetKey,
                backendId,
                agentId,
                title: item.label,
                disabled: !item.enabled,
                ...(!item.enabled && item.readiness && isMachineAgentExecutionStateBlockingV1(item.readiness)
                    ? { unavailableReason: formatMachineAgentExecutionState(item.readiness) } : {}),
                ...(setup ? { setup } : {}),
            };
        });
    }
    return applyMachineFacts(resolveCatalogBackendChoices(params), params);
}

function resolveCatalogBackendChoices(params: ResolveBackendChoicesParams): readonly ExecutionRunLauncherBackendChoice[] {
    const catalogBackendIds = Array.from(
        new Set([
            ...params.enabledAgentIds,
            ...Object.keys(params.executionRunsBackends ?? {}),
        ]),
    )
        .map((id) => String(id ?? '').trim())
        .filter(isCanonicalCatalogBackendId);
    const availableBackendIds = new Set(
        resolveExecutionRunAvailableBackends(params.executionRunsBackends, params.intent),
    );
    const catalogEntries = getResolvedBackendCatalogEntries({
        enabledAgentIds: catalogBackendIds,
        acpCatalogSnapshot: params.acpCatalogSnapshot,
        discoveredBackendIds: Object.keys(params.executionRunsBackends ?? {}).map((id) => String(id ?? '').trim()).filter(isCanonicalCatalogBackendId),
        mergedBackendProjectionById: params.mergedBackendProjectionById ?? null,
        mergedProviderProjectionById: params.mergedProviderProjectionById ?? null,
    });

    return collapseConfiguredAcpBackendCollisions(catalogEntries).map((entry) => {
        const backendId = entry.backendId;
        const catalogAgentId = entry.catalogAgentId;
        const isAvailable = entry.kind === 'configuredBackend'
            ? availableBackendIds.has(entry.backendTargetKey)
                || availableBackendIds.has(backendId)
                || (catalogAgentId ? availableBackendIds.has(catalogAgentId) : false)
                || hasLegacyCompatExecutionRunAvailabilityCarrier(availableBackendIds, backendId)
            : availableBackendIds.has(entry.backendTargetKey) || availableBackendIds.has(backendId);
        return {
            backendTarget: entry.backendTarget,
            targetKey: entry.backendTargetKey,
            backendId,
            agentId: entry.agentId,
            title: entry.title,
            disabled: !isAvailable,
        };
    });
}
