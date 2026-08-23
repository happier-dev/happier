import * as React from 'react';

import {
    readBackendTargetRefV2,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { resolveCatalogAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { backendTargetsMatch, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';

function findEntryByTarget(
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>,
    target: BackendTargetRefV2,
): ResolvedBackendCatalogEntry | null {
    const targetKey = resolveBackendTargetKeyV2(target);
    return entries.find((entry) => entry.backendTargetKey === targetKey) ?? null;
}

function isPluginLikeBackendTarget(target: BackendTargetRefV2 | null | undefined): boolean {
    return !!(target && target.kind === 'backend' && !target.configuredBackendId && !isBundledAgentId(target.backendId));
}

function parsePreservedPluginTarget(value: unknown): BackendTargetRefV2 | null {
    try {
        const parsed = readBackendTargetRefV2(value as any);
        return isPluginLikeBackendTarget(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function shouldPreserveUnresolvedPluginTarget(phase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error' | undefined): boolean {
    return phase !== 'ready';
}

export function useNewSessionBackendTargetState(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
    projectionPhase?: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
}>): Readonly<{
    backendTarget: BackendTargetRefV2;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV2>>;
    selectedCatalogAgentId: AgentId | null;
    selectedRuntimeCarrierAgentId: AgentId | null;
    selectedUiAgentType: string;
}> {
    const applySettings = useApplySettings();
    const [hasExplicitUserSelection, setHasExplicitUserSelection] = React.useState(false);
    const explicitRoutePluginTarget = React.useMemo(() => {
        return parsePreservedPluginTarget(params.routeBackendTarget);
    }, [params.routeBackendTarget]);
    const preservedPluginTarget = React.useMemo(() => {
        if (explicitRoutePluginTarget) {
            return explicitRoutePluginTarget;
        }
        if (!shouldPreserveUnresolvedPluginTarget(params.projectionPhase)) {
            return null;
        }
        return (
            parsePreservedPluginTarget(params.tempBackendTarget)
            ?? parsePreservedPluginTarget(params.persistedBackendTarget)
            ?? parsePreservedPluginTarget(params.lastUsedBackendTarget)
        );
    }, [
        explicitRoutePluginTarget,
        params.lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.projectionPhase,
        params.tempBackendTarget,
    ]);
    const initialBackendTarget = React.useMemo(() => {
        if (preservedPluginTarget) {
            return preservedPluginTarget;
        }
        return resolvePreferredBackendTarget({
            candidateBackendTargets: [params.tempBackendTarget, params.persistedBackendTarget],
            preferredBuiltInAgentIds: [params.tempAgentType],
            availableBackendTargets: params.entries.map((entry) => entry.backendTarget),
            lastUsedAgent: params.lastUsedAgent,
            lastUsedBackendTarget: params.lastUsedBackendTarget,
        });
    }, [
        params.entries,
        params.lastUsedAgent,
        params.lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.tempBackendTarget,
        params.tempAgentType,
        preservedPluginTarget,
    ]);
    const [backendTarget, setBackendTargetState] = React.useState<BackendTargetRefV2>(() => initialBackendTarget);
    const setBackendTarget = React.useCallback<React.Dispatch<React.SetStateAction<BackendTargetRefV2>>>((next) => {
        setHasExplicitUserSelection(true);
        setBackendTargetState(next);
    }, []);
    const matched = React.useMemo(
        () => findEntryByTarget(params.entries, backendTarget),
        [backendTarget, params.entries],
    );

    React.useEffect(() => {
        if (matched) return;
        const shouldKeepExplicitRoutePluginTarget = explicitRoutePluginTarget
            && backendTargetsMatch(explicitRoutePluginTarget, backendTarget);
        if ((shouldPreserveUnresolvedPluginTarget(params.projectionPhase) || shouldKeepExplicitRoutePluginTarget) && isPluginLikeBackendTarget(backendTarget)) {
            return;
        }
        setBackendTarget(initialBackendTarget);
    }, [backendTarget, explicitRoutePluginTarget, initialBackendTarget, matched, params.entries, params.projectionPhase]);

    const selectedCatalogAgentId = React.useMemo<AgentId | null>(() => {
        if (matched?.catalogAgentId && isBundledAgentId(matched.catalogAgentId)) {
            return matched.catalogAgentId;
        }
        if (matched?.kind === 'pluginBackend' || isPluginLikeBackendTarget(backendTarget)) {
            return null;
        }
        return resolveCatalogAgentIdForBackendTarget(backendTarget);
    }, [backendTarget, matched?.catalogAgentId, matched?.kind]);
    const selectedUiAgentType = React.useMemo(() => {
        if (matched?.agentId.trim()) {
            return matched.agentId;
        }
        return backendTarget.backendId;
    }, [backendTarget.backendId, matched?.agentId]);
    const selectedRuntimeCarrierAgentId = React.useMemo(() => {
        const shouldKeepExplicitRoutePluginTarget = explicitRoutePluginTarget
            && backendTargetsMatch(explicitRoutePluginTarget, backendTarget);
        if (
            !matched
            && isPluginLikeBackendTarget(backendTarget)
            && (shouldPreserveUnresolvedPluginTarget(params.projectionPhase) || shouldKeepExplicitRoutePluginTarget)
        ) {
            return null;
        }
        if (matched?.kind === 'pluginBackend') {
            if (matched.catalogAgentId && isBundledAgentId(matched.catalogAgentId)) {
                return matched.catalogAgentId;
            }
            // An installed Agent with no bundled backing still has an
            // operational runtime identity: the Agent the catalog resolved from
            // the current projection. Discarding it is what makes model, mode
            // and configuration probing silently disappear for that Agent.
            return matched.agentId.trim() || null;
        }
        if (matched?.kind === 'configuredBackend') {
            return matched.catalogAgentId ?? null;
        }
        return selectedCatalogAgentId;
    }, [backendTarget, explicitRoutePluginTarget, matched?.kind, matched?.agentId, matched?.catalogAgentId, params.projectionPhase, selectedCatalogAgentId]);
    React.useEffect(() => {
        const currentLastUsedBackendTargetKey = (() => {
            try {
                return resolveBackendTargetKeyV2(readBackendTargetRefV2(params.lastUsedBackendTarget as any));
            } catch {
                return null;
            }
        })();
        const nextBackendTargetKey = resolveBackendTargetKeyV2(backendTarget);
        const persistedSelection = buildLastUsedBackendTargetSettings({
            backendTarget,
            selectedBuiltInAgentId: selectedCatalogAgentId,
        });

        // `lastUsedBackendTarget` is the canonical selection (V2).
        // `lastUsedAgent` is V1 compatibility only and must not be rewritten for configured/plugin targets
        // (otherwise we manufacture legacy compat or other built-in placeholders as the "truth").
        const lastUsedBackendTargetChanged = currentLastUsedBackendTargetKey !== nextBackendTargetKey;
        const hasLastUsedAgentWrite = Object.hasOwn(persistedSelection, 'lastUsedAgent');
        const lastUsedAgentChanged = hasLastUsedAgentWrite
            && params.lastUsedAgent !== persistedSelection.lastUsedAgent;

        if (!lastUsedBackendTargetChanged && !lastUsedAgentChanged) {
            return;
        }

        applySettings({
            ...(lastUsedAgentChanged ? { lastUsedAgent: persistedSelection.lastUsedAgent } : {}),
            ...(lastUsedBackendTargetChanged
                ? { lastUsedBackendTarget: persistedSelection.lastUsedBackendTarget }
                : {}),
        });
    }, [applySettings, backendTarget, params.lastUsedAgent, params.lastUsedBackendTarget, selectedCatalogAgentId]);

    return {
        backendTarget,
        setBackendTarget,
        selectedCatalogAgentId,
        selectedRuntimeCarrierAgentId,
        selectedUiAgentType,
    };
}
