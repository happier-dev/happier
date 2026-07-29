import * as React from 'react';

import {
    readBackendTargetRefV2,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
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
    return !!(target && target.kind === 'backend' && !target.configuredBackendId && !isAgentId(target.backendId));
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

function resolveBuiltInAgentPlaceholder(params: Readonly<{
    tempAgentType: unknown;
    lastUsedAgent: unknown;
}>): AgentId {
    const tempAgentType = isAgentId(params.tempAgentType)
        ? params.tempAgentType
        : null;
    const lastUsedAgent = isAgentId(params.lastUsedAgent)
        ? params.lastUsedAgent
        : null;
    return tempAgentType ?? lastUsedAgent ?? DEFAULT_AGENT_ID;
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
    selectedCatalogAgentId: AgentId;
    selectedRuntimeCarrierAgentId: AgentId | null;
    selectedUiAgentType: AgentId;
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

    const selectedCatalogAgentId = React.useMemo(() => {
        const builtInAgentPlaceholder = resolveBuiltInAgentPlaceholder({
            tempAgentType: params.tempAgentType,
            lastUsedAgent: params.lastUsedAgent,
        });
        if (matched?.kind === 'configuredBackend') {
            return matched.catalogAgentId ?? builtInAgentPlaceholder;
        }
        if (matched?.kind === 'pluginBackend' || isPluginLikeBackendTarget(backendTarget)) {
            if (matched?.catalogAgentId && isAgentId(matched.catalogAgentId)) {
                return matched.catalogAgentId;
            }
            // Draft persistence and new-session controls still require a built-in `agentType` placeholder,
            // but plugin backend identity must not collapse to the ACP sentinel.
            return builtInAgentPlaceholder;
        }
        const resolvedCatalogAgentId = resolveCatalogAgentIdForBackendTarget(backendTarget);
        if (resolvedCatalogAgentId) {
            return resolvedCatalogAgentId;
        }
        return DEFAULT_AGENT_ID;
    }, [backendTarget, matched?.kind, matched?.catalogAgentId, params.lastUsedAgent, params.tempAgentType]);
    const selectedUiAgentType = selectedCatalogAgentId;
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
            if (matched.catalogAgentId && isAgentId(matched.catalogAgentId)) {
                return matched.catalogAgentId;
            }
            return params.projectionPhase === 'loading' ? null : selectedCatalogAgentId;
        }
        if (matched?.kind === 'configuredBackend') {
            return matched.catalogAgentId ?? null;
        }
        return selectedCatalogAgentId;
    }, [backendTarget, explicitRoutePluginTarget, matched?.kind, matched?.catalogAgentId, params.projectionPhase, selectedCatalogAgentId]);
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
