import type { BackendTargetRefV2, PluginContributionIdentityV1 } from '@happier-dev/protocol';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readBackendTargetEnabled } from '@/agents/backendCatalog/backendTargetEnablement';
import { formatBackendTargetKeyV2, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { MergedProviderProjectionEntry } from '@/agents/backendCatalog/mergedProjectionTypes';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

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

/** The runtime selection decision over incumbent catalog facts, without refresh or machine work.
 * Null means the exact selection needs catalog facts that have not been established.
 */
export function projectVoiceConfiguredAgentTarget(params: Readonly<{
    selection: VoiceConfiguredAgentSelection;
    entries: ReturnType<typeof getResolvedBackendCatalogEntries> | null;
    backendEnabledByTargetKey: Settings['backendEnabledByTargetKey'] | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedVoiceConfiguredAgentTarget | null {
    const agentId = normalizeNonEmptyString(params.selection.agentId);
    const targetKeySelection = normalizeNonEmptyString(params.selection.agentTargetKey);
    const externalIdentitySelection = params.selection.agentIdentity ?? null;
    const hasExactFacts = Boolean(targetKeySelection || externalIdentitySelection);
    const configuredCompatBackendId = readLegacyConfiguredAcpBackendId(agentId);
    const unavailable = (): ResolvedVoiceConfiguredAgentTarget => ({
        ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
        agentId: agentId ?? '', agentTargetKey: targetKeySelection,
    });
    if (!agentId) return unavailable();
    if (!targetKeySelection && !externalIdentitySelection && !configuredCompatBackendId) {
        const backendTarget = resolveOperationalBackendTargetForAgentSelection({
            backendTarget: { kind: 'backend', backendId: agentId },
        });
        return isLegacyCompatAgentType(agentId) || !backendTarget ? unavailable() : {
            ok: true, kind: 'legacy', agentId,
            backendTarget, targetKey: null,
        };
    }
    const backendEnabledByTargetKey = params.backendEnabledByTargetKey;
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

    // An exact persisted target is also the user's enablement authority. The
    // projected runtime backend may use a different carrier key, so filtering
    // only the operational catalog entry would silently bypass an explicit
    // disable of the selected contributed Agent.
    if (selectionTargetKey && !readBackendTargetEnabled({
        backendEnabledByTargetKey,
        canonicalTargetKey: selectionTargetKey,
    })) {
        return {
            ok: false,
            errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
            agentId,
            agentTargetKey: targetKeySelection,
        };
    }

    if (!params.entries) return null;
    const entries = params.entries;

    let matchByKey: (typeof entries)[number] | null = null;
    let matchByIdentity: (typeof entries)[number] | null = null;
    for (const entry of entries) {
        if (matchByKey && matchByIdentity) break;
        if (!matchByKey && configuredCompatBackendId && !hasExactFacts && entry.kind === 'configuredBackend'
            && readBackendTargetRefV2(entry.backendTarget).configuredBackendId === configuredCompatBackendId) {
            matchByKey = entry;
        }
        if (!matchByKey && selectionTargetKey) {
            // A catalog entry addresses targets in two canonical vocabularies:
            // its exact contribution key and its operational backend key. A
            // persisted selection written in either form resolves to it.
            const operationalTarget = resolveOperationalBackendTargetForAgentSelection({
                backendTarget: entry.backendTarget,
                selectedEntry: entry,
                mergedProviderProjectionById: params.mergedProviderProjectionById ?? null,
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
        mergedProviderProjectionById: params.mergedProviderProjectionById ?? null,
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
