import * as React from 'react';

import { PersistedBackendTargetRefV2Schema, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId } from '@/agents/catalog/catalog';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { resolveCatalogAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useSettingsSelector } from '@/sync/store/hooks';
import { backendTargetKeysMatch, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { findMachineAgentForBackendTargetKey } from '@/agents/machineAgents/machineAgentCatalog';
import { isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';

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
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
    projectionPhase?: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    machineTarget?: Readonly<{ machineId: string | null; serverId: string; load?: boolean; inventoryDemanded?: boolean }>;
}>): Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    setBackendTarget: React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>;
    selectedCatalogAgentId: AgentId | null;
    selectedRuntimeCarrierAgentId: string | null;
    selectedUiAgentType: string;
    machineAgents: ReturnType<typeof useMachineAgents>;
}> {
    const expectedSettingsScope = useAccountSettingsScope();
    const [hasExplicitUserSelection, setHasExplicitUserSelection] = React.useState(false);
    const explicitRouteTarget = React.useMemo(() => {
        const parsed = PersistedBackendTargetRefV2Schema.safeParse(params.routeBackendTarget);
        return parsed.success ? parsed.data : null;
    }, [params.routeBackendTarget]);
    const rememberedDefaults = useSettingsSelector(React.useCallback(settings => (
        hasExplicitUserSelection || explicitRouteTarget ? null : {
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
        }
    ), [explicitRouteTarget, hasExplicitUserSelection]), ["lastUsedAgent","lastUsedBackendTarget"]);
    const lastUsedAgent = rememberedDefaults?.lastUsedAgent;
    const lastUsedBackendTarget = rememberedDefaults?.lastUsedBackendTarget;
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
            ?? parsePreservedPluginTarget(lastUsedBackendTarget)
        );
    }, [
        explicitRoutePluginTarget,
        lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.projectionPhase,
        params.tempBackendTarget,
    ]);
    const initialBackendTarget = React.useMemo(() => {
        if (explicitRouteTarget) return explicitRouteTarget;
        if (preservedPluginTarget) {
            return preservedPluginTarget;
        }
        const availableBackendTargets = params.entries.map((entry) => entry.backendTarget);
        return resolvePreferredBackendTarget({
            candidateBackendTargets: [params.routeBackendTarget, params.tempBackendTarget, params.persistedBackendTarget],
            preferredBuiltInAgentIds: [params.tempAgentType],
            availableBackendTargets,
            lastUsedAgent,
            lastUsedBackendTarget,
        });
    }, [
        params.entries,
        params.configuredCatalogReady,
        explicitRouteTarget,
        lastUsedAgent,
        lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.routeBackendTarget,
        params.tempBackendTarget,
        params.tempAgentType,
        preservedPluginTarget,
    ]);
    const [backendTarget, setBackendTargetState] = React.useState<PersistedBackendTargetRefV2>(() => initialBackendTarget);
    // A saved selection can arrive after mount. Hydrate it before committing
    // authoring effects; a matching fallback catalog row is not authored intent.
    if (!hasExplicitUserSelection
        && (explicitRouteTarget || params.tempBackendTarget || params.persistedBackendTarget || params.tempAgentType)
        && !backendTargetKeysMatch(backendTarget, initialBackendTarget)) {
        setBackendTargetState(initialBackendTarget);
    }
    const setBackendTarget = React.useCallback<React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>>((next) => {
        setHasExplicitUserSelection(true);
        // Picker rows reuse their target object. A fresh selection still owns
        // a state transition when another Session changed the remembered default.
        setBackendTargetState(previous => ({ ...(typeof next === 'function' ? next(previous) : next) }));
    }, []);
    const matched = React.useMemo(
        () => findEntryByTarget(params.entries, backendTarget),
        [backendTarget, params.entries],
    );
    const implicitDefault = !hasExplicitUserSelection && !explicitRouteTarget && !params.tempBackendTarget
        && !params.persistedBackendTarget && !params.tempAgentType && !lastUsedAgent && !lastUsedBackendTarget;
    const selectedInventoryAgentId = matched && matched.kind !== 'configuredBackend' ? matched.agentId : undefined;
    // An implicit choice needs the alternatives' admitted Account-default credentials.
    // Authored choices keep the incumbent selected-Agent probe; opening the picker expands it.
    const inventoryDemanded = params.machineTarget?.inventoryDemanded === true || implicitDefault;
    const machineAgents = useMachineAgents({
        machineId: params.machineTarget?.machineId ?? null,
        serverId: params.machineTarget?.serverId,
        agentId: inventoryDemanded ? undefined : selectedInventoryAgentId,
        load: params.machineTarget?.load !== false && (inventoryDemanded || Boolean(selectedInventoryAgentId)),
    });
    const preferredBackendTarget = React.useMemo(() => {
        if (!implicitDefault) return initialBackendTarget;
        const readyBackendTargets = params.entries.filter(entry => isMachineAgentReady(
            findMachineAgentForBackendTargetKey(machineAgents.agents, entry.backendTargetKey),
        )).map(entry => entry.backendTarget);
        // Losing readiness during refresh does not invent another usable choice.
        if (readyBackendTargets.length === 0 && matched) return backendTarget;
        return resolvePreferredBackendTarget({
            availableBackendTargets: params.entries.map(entry => entry.backendTarget),
            readyBackendTargets,
            lastUsedAgent,
            lastUsedBackendTarget,
        });
    }, [backendTarget, implicitDefault, initialBackendTarget, lastUsedAgent, lastUsedBackendTarget, machineAgents.agents, matched, params.entries]);
    const configuredTargetUnavailable = isConfiguredTarget(backendTarget)
        && (params.configuredCatalogReady === false || matched === null);

    React.useEffect(() => {
        // Catalog/default hydration cannot replace authored intent. Missing
        // availability is handled by launch admission, not by choosing an Agent.
        if (hasExplicitUserSelection) return;
        if (explicitRouteTarget && backendTargetKeysMatch(explicitRouteTarget, backendTarget)) return;
        if (configuredTargetUnavailable) return;
        if (matched && !implicitDefault) return;
        const shouldKeepExplicitRoutePluginTarget = explicitRoutePluginTarget
            && backendTargetKeysMatch(explicitRoutePluginTarget, backendTarget);
        if ((shouldPreserveUnresolvedPluginTarget(params.projectionPhase) || shouldKeepExplicitRoutePluginTarget) && isPluginLikeBackendTarget(backendTarget)) {
            return;
        }
        if (backendTargetKeysMatch(backendTarget, preferredBackendTarget)) return;
        setBackendTargetState(preferredBackendTarget);
    }, [backendTarget, configuredTargetUnavailable, explicitRoutePluginTarget, explicitRouteTarget, hasExplicitUserSelection, implicitDefault, preferredBackendTarget, matched, params.entries, params.projectionPhase]);

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
    const lastPersistedExplicitTarget = React.useRef<PersistedBackendTargetRefV2 | null>(null);
    React.useEffect(() => {
        if (configuredTargetUnavailable || !hasExplicitUserSelection) return;
        const nextBackendTargetKey = resolveBackendTargetKeyV2(backendTarget);
        // Catalog hydration and Account preference updates are not picker intent.
        if (lastPersistedExplicitTarget.current === backendTarget) return;
        lastPersistedExplicitTarget.current = backendTarget;
        const persistedSelection = buildLastUsedBackendTargetSettings({
            backendTarget,
            selectedBuiltInAgentId: selectedCatalogAgentId,
        });

        // `lastUsedBackendTarget` is the canonical selection (V2).
        // `lastUsedAgent` is V1 compatibility only and must not be rewritten for configured/plugin targets
        // (otherwise we manufacture legacy compat or other built-in placeholders as the "truth").
        const current = getStorage().getState().settings;
        const parsed = PersistedBackendTargetRefV2Schema.safeParse(current.lastUsedBackendTarget);
        const currentLastUsedBackendTargetKey = parsed.success ? resolveBackendTargetKeyV2(parsed.data) : null;
        const lastUsedBackendTargetChanged = currentLastUsedBackendTargetKey !== nextBackendTargetKey;
        const hasLastUsedAgentWrite = Object.hasOwn(persistedSelection, 'lastUsedAgent');
        const lastUsedAgentChanged = hasLastUsedAgentWrite
            && current.lastUsedAgent !== persistedSelection.lastUsedAgent;
        if (!lastUsedBackendTargetChanged && !lastUsedAgentChanged) return;
        getSyncSingleton().applySettings({
            ...(lastUsedAgentChanged ? { lastUsedAgent: persistedSelection.lastUsedAgent } : {}),
            ...(lastUsedBackendTargetChanged
                ? { lastUsedBackendTarget: persistedSelection.lastUsedBackendTarget }
                : {}),
        }, { expectedSettingsScope, source: 'ui' });
    }, [expectedSettingsScope, backendTarget, configuredTargetUnavailable, hasExplicitUserSelection, selectedCatalogAgentId]);

    return {
        backendTarget,
        setBackendTarget,
        selectedCatalogAgentId,
        selectedRuntimeCarrierAgentId,
        selectedUiAgentType,
        machineAgents,
    };
}
