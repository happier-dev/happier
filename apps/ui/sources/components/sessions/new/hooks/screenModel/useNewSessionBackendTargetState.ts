import * as React from 'react';

import { PersistedBackendTargetRefV2Schema, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId } from '@/agents/catalog/catalog';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { resolveCatalogAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { backendTargetKeysMatch, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';

function findEntryByTarget(
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>,
    target: PersistedBackendTargetRefV2,
): ResolvedBackendCatalogEntry | null {
    const targetKey = resolveBackendTargetKeyV2(target);
    return entries.find((entry) => entry.backendTargetKey === targetKey) ?? null;
}

function isPluginLikeBackendTarget(target: PersistedBackendTargetRefV2 | null | undefined): boolean {
    if (!target) return false;
    if (target.kind === 'agent') {
        return resolveBundledAgentIdFromContributionIdentity(target.identity) === null;
    }
    return !target.configuredBackendId && !isBundledAgentId(target.backendId);
}

function isConfiguredTarget(target: PersistedBackendTargetRefV2): boolean {
    return target.kind === 'agent' ? target.definitionId !== undefined : Boolean(target.configuredBackendId);
}

function parsePreservedPluginTarget(value: unknown): PersistedBackendTargetRefV2 | null {
    const parsed = PersistedBackendTargetRefV2Schema.safeParse(value);
    return parsed.success && isPluginLikeBackendTarget(parsed.data) ? parsed.data : null;
}

function shouldPreserveUnresolvedPluginTarget(phase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error' | undefined): boolean {
    return phase !== 'ready';
}

export function useNewSessionBackendTargetState(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    configuredCatalogReady?: boolean;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
    projectionPhase?: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
}>): Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    setBackendTarget: React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>;
    selectedCatalogAgentId: AgentId | null;
    selectedRuntimeCarrierAgentId: string | null;
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
        const availableBackendTargets = params.entries.map((entry) => entry.backendTarget);
        return resolvePreferredBackendTarget({
            candidateBackendTargets: [params.routeBackendTarget, params.tempBackendTarget, params.persistedBackendTarget],
            preferredBuiltInAgentIds: [params.tempAgentType],
            availableBackendTargets,
            lastUsedAgent: params.lastUsedAgent,
            lastUsedBackendTarget: params.lastUsedBackendTarget,
        });
    }, [
        params.entries,
        params.configuredCatalogReady,
        params.lastUsedAgent,
        params.lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.routeBackendTarget,
        params.tempBackendTarget,
        params.tempAgentType,
        preservedPluginTarget,
    ]);
    const [backendTarget, setBackendTargetState] = React.useState<PersistedBackendTargetRefV2>(() => initialBackendTarget);
    const setBackendTarget = React.useCallback<React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>>((next) => {
        setHasExplicitUserSelection(true);
        setBackendTargetState(next);
    }, []);
    const matched = React.useMemo(
        () => findEntryByTarget(params.entries, backendTarget),
        [backendTarget, params.entries],
    );
    const configuredTargetUnavailable = isConfiguredTarget(backendTarget)
        && (params.configuredCatalogReady === false || matched === null);

    React.useEffect(() => {
        if (configuredTargetUnavailable) return;
        if (matched) return;
        const shouldKeepExplicitRoutePluginTarget = explicitRoutePluginTarget
            && backendTargetKeysMatch(explicitRoutePluginTarget, backendTarget);
        if ((shouldPreserveUnresolvedPluginTarget(params.projectionPhase) || shouldKeepExplicitRoutePluginTarget) && isPluginLikeBackendTarget(backendTarget)) {
            return;
        }
        if (backendTargetKeysMatch(backendTarget, initialBackendTarget)) return;
        setBackendTargetState(initialBackendTarget);
    }, [backendTarget, configuredTargetUnavailable, explicitRoutePluginTarget, initialBackendTarget, matched, params.entries, params.projectionPhase]);

    const selectedCatalogAgentId = React.useMemo<AgentId | null>(() => {
        if (matched?.catalogAgentId && isBundledAgentId(matched.catalogAgentId)) {
            return matched.catalogAgentId;
        }
        if (isConfiguredTarget(backendTarget)) return null;
        if (matched?.kind === 'pluginBackend' || isPluginLikeBackendTarget(backendTarget)) {
            return null;
        }
        return backendTarget.kind === 'agent'
            ? resolveBundledAgentIdFromContributionIdentity(backendTarget.identity)
            : resolveCatalogAgentIdForBackendTarget(backendTarget);
    }, [backendTarget, matched?.catalogAgentId, matched?.kind]);
    const selectedUiAgentType = React.useMemo(() => {
        if (matched?.agentId.trim()) {
            return matched.agentId;
        }
        return backendTarget.kind === 'agent'
            ? buildQualifiedPluginContributionKey(backendTarget.identity)
            : backendTarget.backendId;
    }, [backendTarget, matched?.agentId]);
    const selectedRuntimeCarrierAgentId = React.useMemo(() => {
        if (configuredTargetUnavailable) return null;
        const shouldKeepExplicitRoutePluginTarget = explicitRoutePluginTarget
            && backendTargetKeysMatch(explicitRoutePluginTarget, backendTarget);
        if (
            !matched
            && isPluginLikeBackendTarget(backendTarget)
            && (shouldPreserveUnresolvedPluginTarget(params.projectionPhase) || shouldKeepExplicitRoutePluginTarget)
        ) {
            return null;
        }
        if (matched?.kind === 'pluginBackend') {
            // catalogAgentId is presentation/default backing only. Runtime
            // probing, scoped settings, spawn, and resume must all address the
            // operational Agent the current projection resolved.
            return matched.agentId.trim() || null;
        }
        if (matched?.kind === 'configuredBackend') {
            return matched.agentId.trim() || null;
        }
        return selectedCatalogAgentId;
    }, [backendTarget, configuredTargetUnavailable, explicitRoutePluginTarget, matched?.kind, matched?.agentId, matched?.catalogAgentId, params.projectionPhase, selectedCatalogAgentId]);
    React.useEffect(() => {
        if (configuredTargetUnavailable || !hasExplicitUserSelection) return;
        const currentLastUsedBackendTargetKey = (() => {
            const parsed = PersistedBackendTargetRefV2Schema.safeParse(params.lastUsedBackendTarget);
            return parsed.success ? resolveBackendTargetKeyV2(parsed.data) : null;
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
    }, [applySettings, backendTarget, configuredTargetUnavailable, hasExplicitUserSelection, params.lastUsedAgent, params.lastUsedBackendTarget, selectedCatalogAgentId]);

    return {
        backendTarget,
        setBackendTarget,
        selectedCatalogAgentId,
        selectedRuntimeCarrierAgentId,
        selectedUiAgentType,
    };
}
