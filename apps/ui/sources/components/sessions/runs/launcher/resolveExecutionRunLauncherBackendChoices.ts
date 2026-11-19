import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveBundledAgentIdFromContributionIdentity } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
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
import { resolveMachineAgentPickerPlacement } from '@/components/machines/agents/machineAgentPresentation';

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
    /** Where the Machine's own inventory says this Agent is, when it is not ready to run there. */
    unavailable?: 'notOnMachine' | 'cantRun';
}>;

export function resolveInitialExecutionRunBackendTargetKey(
    initialTarget: PersistedBackendTargetRefV2 | null,
    choices: readonly ExecutionRunLauncherBackendChoice[],
): string | null {
    if (!initialTarget) return null;
    const canonicalTargetKey = buildBackendTargetKeyV2(initialTarget);
    return choices.find((choice) => (
        choice.disabled !== true
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
        const agent = findMachineAgentForBackendTargetKey(params.machineAgents ?? [], choice.targetKey);
        const group = resolveMachineAgentPickerPlacement(agent).group;
        const unavailable = group === 'onMachine' ? undefined : group;
        return {
            ...choice,
            disabled: choice.disabled || unread || unavailable !== undefined,
            ...(unavailable ? { unavailable } : {}),
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
            return {
                reviewEngineId: item.engineId,
                reviewInventoryItem: item,
                backendTarget,
                targetKey,
                backendId,
                agentId,
                title: item.label,
                disabled: !item.enabled,
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
