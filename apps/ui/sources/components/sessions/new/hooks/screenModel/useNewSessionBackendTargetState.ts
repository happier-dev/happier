import * as React from 'react';

import { PersistedBackendTargetRefV2Schema, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId } from '@/agents/catalog/catalog';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { resolveCatalogAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import { rememberLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';
import { backendTargetKeysMatch, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildLastUsedBackendTargetSettings } from '@/agents/backendCatalog/buildLastUsedBackendTargetSettings';
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';

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
    isSending?: boolean;
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
    const rememberedDefaults = useLastUsedBackendSelection(!hasExplicitUserSelection && !explicitRouteTarget);
    const { lastUsedAgent, lastUsedBackendTarget } = rememberedDefaults;
    const followsAccountPurposeDefault = !hasExplicitUserSelection && !explicitRouteTarget
        && !params.tempBackendTarget && !params.persistedBackendTarget && !params.tempAgentType;
    const { binding } = useServerCredentialAccountScopeBinding(params.machineTarget?.serverId ?? expectedSettingsScope?.serverId);
    const purposeCatalog = useConnectedAccountCatalog('purposes', binding?.scope ?? null, {
        sourceMachineId: params.machineTarget?.machineId,
        enabled: followsAccountPurposeDefault,
    });
    const previousPurposeBindings = React.useRef(purposeCatalog.value);
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
        const availableBackendTargets = params.entries.map((entry) => entry.backendTarget);
        const purposeBindings = purposeCatalog.value;
        // A credential-purpose default expresses Account intent. Native probes
        // and sibling readiness never participate in choosing the target.
        const purposeDefaultTargets = followsAccountPurposeDefault && purposeBindings
            ? params.entries.filter(({ agentCatalogEntry: agent }) => agent.identity
                && resolveAgentConnectedAccountPurposeDefaults({
                    settings: {}, purposeBindings,
                    agentId: agent.agentId, consumer: agent.identity, declarations: agent.connectedAccounts,
                }).some(purpose => purpose.target !== null || purpose.teamResource !== null)).map(entry => entry.backendTarget)
            : [];
        if (preservedPluginTarget && purposeDefaultTargets.length === 0) {
            return preservedPluginTarget;
        }
        return resolvePreferredBackendTarget({
            candidateBackendTargets: [params.routeBackendTarget, params.tempBackendTarget, params.persistedBackendTarget],
            preferredBuiltInAgentIds: [params.tempAgentType],
            availableBackendTargets: purposeDefaultTargets.length > 0 ? purposeDefaultTargets : availableBackendTargets,
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
        followsAccountPurposeDefault,
        purposeCatalog.value,
    ]);
    const [backendTarget, setBackendTargetState] = React.useState<PersistedBackendTargetRefV2>(() => initialBackendTarget);
    // A saved selection can arrive after mount. Hydrate it before committing
    // authoring effects; a matching fallback catalog row is not authored intent.
    if (!hasExplicitUserSelection && !params.isSending
        && (explicitRouteTarget || params.tempBackendTarget || params.persistedBackendTarget || params.tempAgentType)
        && !backendTargetKeysMatch(backendTarget, initialBackendTarget)) {
        setBackendTargetState(initialBackendTarget);
    }
    const setBackendTarget = React.useCallback<React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>>((next) => {
        if (params.isSending) return;
        setHasExplicitUserSelection(true);
        // Picker rows reuse their target object. A fresh selection still owns
        // a state transition when another Session changed the remembered default.
        setBackendTargetState(previous => ({ ...(typeof next === 'function' ? next(previous) : next) }));
    }, [params.isSending]);
    const matched = React.useMemo(
        () => findEntryByTarget(params.entries, backendTarget),
        [backendTarget, params.entries],
    );
    const selectedInventoryAgentId = matched && matched.kind !== 'configuredBackend' ? matched.agentId : undefined;
    // Probe the displayed choice; alternatives are demanded when the picker opens.
    const inventoryDemanded = params.machineTarget?.inventoryDemanded === true;
    const machineAgents = useMachineAgents({
        machineId: params.machineTarget?.machineId ?? null,
        serverId: params.machineTarget?.serverId,
        agentId: inventoryDemanded ? undefined : selectedInventoryAgentId,
        load: params.machineTarget?.load !== false && (inventoryDemanded || Boolean(selectedInventoryAgentId)),
    });
    const configuredTargetUnavailable = isConfiguredTarget(backendTarget)
        && (params.configuredCatalogReady === false || matched === null);

    React.useEffect(() => {
        // Catalog/default hydration cannot replace authored intent. Missing
        // availability is handled by launch admission, not by choosing an Agent.
        if (params.isSending || hasExplicitUserSelection) return;
        const purposeDefaultChanged = purposeCatalog.value !== null
            && !sameStrictJsonValue(previousPurposeBindings.current, purposeCatalog.value);
        // A catalog refresh or an acknowledgement of the same defaults is not
        // new selection intent. Keep a pending default change through Send.
        if (purposeCatalog.value) previousPurposeBindings.current = purposeCatalog.value;
        if (explicitRouteTarget && backendTargetKeysMatch(explicitRouteTarget, backendTarget)) return;
        if (!followsAccountPurposeDefault || !purposeDefaultChanged) {
            if (configuredTargetUnavailable || matched) return;
            const shouldKeepExplicitRoutePluginTarget = explicitRoutePluginTarget
                && backendTargetKeysMatch(explicitRoutePluginTarget, backendTarget);
            if ((shouldPreserveUnresolvedPluginTarget(params.projectionPhase) || shouldKeepExplicitRoutePluginTarget) && isPluginLikeBackendTarget(backendTarget)) {
                return;
            }
        }
        if (backendTargetKeysMatch(backendTarget, initialBackendTarget)) return;
        setBackendTargetState(initialBackendTarget);
    }, [backendTarget, configuredTargetUnavailable, explicitRoutePluginTarget, explicitRouteTarget, followsAccountPurposeDefault, hasExplicitUserSelection, initialBackendTarget, matched, params.entries, params.isSending, params.projectionPhase, purposeCatalog.value]);

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
        // Catalog hydration and Account preference updates are not picker intent.
        if (lastPersistedExplicitTarget.current === backendTarget) return;
        lastPersistedExplicitTarget.current = backendTarget;
        const persistedSelection = buildLastUsedBackendTargetSettings({
            backendTarget,
            selectedBuiltInAgentId: selectedCatalogAgentId,
        });

        // The builder preserves the legacy Agent fallback for configured/plugin
        // targets; the keyed device owner suppresses unchanged observations.
        rememberLastUsedBackendSelection(expectedSettingsScope, persistedSelection);
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
