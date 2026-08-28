import {
    type BackendTargetRefV2,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { formatBackendTargetKeyV2, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import {
    getResolvedBackendCatalogEntries,
    resolveOperationalBackendTargetForAgentSelection,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

/**
 * Typed failure code for a configured Voice Agent selection that the current
 * catalog can no longer honor (uninstalled, disabled, or a stale external
 * projection). Every consumer fails closed on it instead of silently running a
 * different Agent than the one the user picked.
 */
export const VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE = 'voice_agent_selection_unavailable';

/** The persisted Voice Agent selection facts owned by the Voice profile. */
export type VoiceConfiguredAgentSelection = Readonly<{
    agentId: string;
    agentTargetKey: string | null | undefined;
    agentIdentity: Readonly<{ pluginId: string; localId: string }> | null | undefined;
}>;

export type ResolvedVoiceConfiguredAgentTarget =
    | Readonly<{
        ok: true;
        /** Resolved against the current catalog with exact target facts. */
        kind: 'catalog';
        agentId: string;
        backendTarget: BackendTargetRefV2;
        targetKey: string;
    }>
    | Readonly<{
        ok: true;
        /** Selection written before exact facts existed; raw id carries it. */
        kind: 'legacy';
        agentId: string;
        backendTarget: BackendTargetRefV2;
        targetKey: null;
    }>
    | Readonly<{
        ok: false;
        errorCode: typeof VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE;
        agentId: string;
        agentTargetKey: string | null;
    }>;

function sameIdentity(
    left: PluginContributionIdentityV1 | null | undefined,
    right: Readonly<{ pluginId: string; localId: string }> | null | undefined,
): boolean {
    return !!left && !!right
        && left.pluginId === right.pluginId
        && left.localId === right.localId;
}

/**
 * The ONE resolver that turns the user's configured Voice Agent selection into
 * the exact backend target the spawn and start corridors execute.
 *
 * A selection carrying exact facts (target key and/or qualified identity) is
 * resolved against the current Agent catalog — the machine's projection for
 * external Agents, the local catalog for bundled ones. A selection the current
 * catalog cannot honor fails closed: spawning or starting a different Agent
 * than the one the user picked is a silent correctness bug, not a fallback.
 * Selections written before exact target facts existed keep the legacy raw-id
 * behavior so every persisted bundled profile continues to work.
 */
export async function resolveVoiceConfiguredAgentTarget(params: Readonly<{
    machineId: string | null | undefined;
    selection: VoiceConfiguredAgentSelection;
}>): Promise<ResolvedVoiceConfiguredAgentTarget> {
    const agentId = normalizeNonEmptyString(params.selection.agentId);
    if (!agentId) {
        return {
            ok: false,
            errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
            agentId: '',
            agentTargetKey: normalizeNonEmptyString(params.selection.agentTargetKey),
        };
    }
    const targetKeySelection = normalizeNonEmptyString(params.selection.agentTargetKey);
    const identitySelection = params.selection.agentIdentity ?? null;
    const hasExactFacts = Boolean(targetKeySelection || identitySelection);
    if (!hasExactFacts) {
        return {
            ok: true,
            kind: 'legacy',
            agentId,
            backendTarget: { kind: 'backend', backendId: agentId },
            targetKey: null,
        };
    }

    const state = storage.getState();
    const backendEnabledByTargetKey = state.settings?.backendEnabledByTargetKey ?? null;
    const externalIdentitySelection = identitySelection;
    const projectionInputs = externalIdentitySelection
        ? await loadDaemonMergedProjectionInputs({
            machineId: normalizeNonEmptyString(params.machineId),
            serverId: getActiveServerSnapshot().serverId,
        })
        : null;
    const entries = getResolvedBackendCatalogEntries({
        enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
        acpCatalogSettingsV1: state.settings?.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
        backendEnabledByTargetKey,
        mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: projectionInputs?.mergedBackendProjectionById ?? null,
        discoveredBackendIds: projectionInputs?.discoveredBackendIds ?? undefined,
    });

    const selectionTargetKey = targetKeySelection
        ? (() => {
            try {
                return resolveBackendTargetKeyV2(targetKeySelection);
            } catch {
                // A malformed persisted key cannot address a target. The
                // qualified identity, when present, remains authoritative.
                return null;
            }
        })()
        : null;

    let matchByKey: (typeof entries)[number] | null = null;
    let matchByIdentity: (typeof entries)[number] | null = null;
    for (const entry of entries) {
        if (matchByKey && matchByIdentity) break;
        if (!matchByKey && selectionTargetKey) {
            // A catalog entry addresses targets in two canonical vocabularies:
            // its exact contribution key and its operational backend key. A
            // persisted selection written in either form resolves to it.
            const operationalTarget = resolveOperationalBackendTargetForAgentSelection({
                backendTarget: entry.backendTarget,
                selectedEntry: entry,
                mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById ?? null,
            });
            const entryKeys = [
                formatBackendTargetKeyV2(entry.backendTarget),
                ...(operationalTarget ? [resolveBackendTargetKeyV2(operationalTarget)] : []),
            ];
            if (entryKeys.includes(selectionTargetKey)) {
                matchByKey = entry;
            }
        }
        if (!matchByIdentity && sameIdentity(entry.agentCatalogEntry.identity, externalIdentitySelection)) {
            matchByIdentity = entry;
        }
    }

    // The exact target key is the primary fact; the identity is the recovery
    // path when the key cannot be honored (malformed, or the projection
    // re-keyed the Agent while keeping its identity).
    const match = matchByKey ?? matchByIdentity;
    if (!match) {
        return {
            ok: false,
            errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
            agentId,
            agentTargetKey: targetKeySelection,
        };
    }
    const operationalTarget = resolveOperationalBackendTargetForAgentSelection({
        backendTarget: match.backendTarget,
        selectedEntry: match,
        mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById ?? null,
    });
    if (!operationalTarget) {
        return {
            ok: false,
            errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
            agentId,
            agentTargetKey: targetKeySelection,
        };
    }
    return {
        ok: true,
        kind: 'catalog',
        agentId: match.agentId,
        backendTarget: operationalTarget,
        // Echo the selection's canonical key so a persisted profile round-trips
        // stably; only an identity-recovered match adopts the catalog key.
        targetKey: selectionTargetKey ?? formatBackendTargetKeyV2(match.backendTarget),
    };
}
