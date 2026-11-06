import * as React from 'react';

import {
    getAgentResumeExperimentsFromSettings,
    getNewSessionRelevantInstallableDepKeys,
    type AgentId,
} from '@/agents/catalog/catalog';
import {
    type ResolvedBackendCatalogEntry,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import type { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';
import { findMachineAgentForBackendTargetKey } from '@/agents/machineAgents/machineAgentCatalog';
import { projectMachineAgentsToCliAvailability } from '@/agents/machineAgents/machineAgentCliAvailability';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { isProfileCompatibleWithBackendTarget } from '@/sync/domains/profiles/profileCompatibility';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import {
    isAgentSelectableForNewSession,
    isBackendEntrySelectableForNewSession,
    resolveBackendEntryUnavailabilityReasonForNewSession,
    resolveProfileAvailabilityForNewSession,
} from '@/components/sessions/new/modules/newSessionAgentSelection';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { resolveWindowsTerminalAvailable } from '@/capabilities/windowsTerminalAvailability';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from '@/sync/store/hooks';
import type {
    AgentPluginSettingsReadiness,
    AgentPluginSettingsSnapshot,
} from '@/agents/registry/registryUiBehavior';
import type { PersistedBackendTargetRefV2, PluginProjectionV2 } from '@happier-dev/protocol';
import type { BackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';

type ProfileAvailability = Readonly<{ available: boolean; reason?: string }>;

export function useNewSessionAvailabilityState(params: Readonly<{
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    /** The selection owner and launch admission consume the same credential-qualified inventory. */
    machineAgents: ReturnType<typeof useMachineAgents>;
    /** Embedded composers read cached availability until the person reaches for them. */
    machineProbesEnabled?: boolean;
    windowsTerminalRequested?: boolean;
    capabilityServerId: string;
    externalSessionsFeatureEnabled: boolean;
    settings: Parameters<typeof resolveTerminalHost>[0]['settings'] & Pick<Settings, 'backendEnabledByTargetKey'>;
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    pluginSettingsAgentId?: string | null;
    pluginSettingsReadiness?: AgentPluginSettingsReadiness | null;
    /** Explicit bundled behavior backing for static New Session controls. */
    staticAgentId?: AgentId | null;
    /**
     * The selected target's operational Agent identity, which an installed
     * (non-bundled) Agent has even though it has no bundled catalog backing.
     */
    runtimeCarrierAgentId?: string | null;
    /** Current daemon projection for the selected machine's public managed dependencies. */
    pluginProjectionV2?: Pick<PluginProjectionV2, 'familiesById'> | null;
    /** @deprecated Direct callers without a projected backend entry are bundled-only. */
    agentType?: AgentId;
    resumeSessionId: string | null;
    backendNewSessionOptionStateByTargetKey: Readonly<BackendNewSessionOptionStateByTargetKey>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    setBackendTarget: React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>;
    machines: ReadonlyArray<Machine>;
    allProfiles: ReadonlyArray<AIBackendProfile>;
}>) {
    const { binding } = useServerCredentialAccountScopeBinding(params.capabilityServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const machineProbesEnabled = params.machineProbesEnabled !== false;
    const staticAgentId = params.staticAgentId ?? params.agentType ?? null;
    const behaviorAgentId = resolveNewSessionBehaviorAgentId({
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        staticAgentId,
        agentType: params.agentType,
    });
    const selectedAgentSettingsReady = params.pluginSettingsReadiness === null
        || params.pluginSettingsReadiness === undefined
        || params.pluginSettingsReadiness.ready;
    const machineAgents = params.machineAgents;
    // A configured definition is a distinct inventory row, even when its Agent is shared.
    const machineAgentsById = React.useMemo(() => Object.fromEntries(machineAgents.agents.map((agent) => [buildMachineAgentInventoryKey(agent), agent])), [machineAgents.agents]);
    const getBackendEntryMachineAgent = React.useCallback((entry: ResolvedBackendCatalogEntry) =>
        findMachineAgentForBackendTargetKey(machineAgents.agents, entry.backendTargetKey), [machineAgents.agents]);
    const tmuxRequested = resolveTerminalHost({ settings: params.settings, machineId: params.selectedMachineId }) === 'tmux';
    // Agent callbacks can read arbitrary released Account carriers; whole-snapshot demand is explicit.
    const relevantInstallableDepKeys = useSettingsSelector(React.useCallback((settings) => {
        if (!params.selectedMachineId || !behaviorAgentId) return [];

        const experiments = getAgentResumeExperimentsFromSettings(behaviorAgentId, settings, params.selectedMachineId, params.pluginSettings);
        return getNewSessionRelevantInstallableDepKeys({
            agentId: behaviorAgentId,
            settings,
            experiments,
            pluginSettings: params.pluginSettings,
            resumeSessionId: params.resumeSessionId ?? '',
            machineId: params.selectedMachineId,
        });
    }, [behaviorAgentId, params.pluginSettings, params.pluginProjectionV2, params.resumeSessionId, params.selectedMachineId]), true);
    const selectedInstallables = React.useMemo(() => relevantInstallableDepKeys.length === 0 ? []
        : getInstallablesRegistryEntries({ pluginProjection: params.pluginProjectionV2 ?? undefined })
            .filter((entry) => relevantInstallableDepKeys.includes(entry.key)), [params.pluginProjectionV2, relevantInstallableDepKeys]);
    const systemRequest = React.useMemo(() => ({ requests: [
        ...(tmuxRequested ? [{ id: 'tool.tmux' as const }] : []),
        ...(params.windowsTerminalRequested ? [{ id: 'tool.windowsTerminal' as const }] : []),
        ...selectedInstallables.map((entry) => ({ id: entry.capabilityId })),
    ] }), [params.windowsTerminalRequested, selectedInstallables, tmuxRequested]);
    const { state: selectedMachineCapabilities, refresh: refreshSelectedMachineCapabilities, cacheKeySalt } = useDaemonScopedMachineCapabilitiesCache({
        machineId: params.selectedMachineId,
        serverId: params.capabilityServerId,
        enabled: false,
        request: systemRequest,
    });
    const selectedMachineCapabilitiesSnapshot = React.useMemo(() => {
        return selectedMachineCapabilities.status === 'loaded'
            ? selectedMachineCapabilities.snapshot
            : selectedMachineCapabilities.status === 'loading'
                ? selectedMachineCapabilities.snapshot
                : selectedMachineCapabilities.status === 'error'
                    ? selectedMachineCapabilities.snapshot
                    : undefined;
    }, [selectedMachineCapabilities]);

    const cliAvailability = React.useMemo(() => projectMachineAgentsToCliAvailability({
        ...machineAgents,
        systemToolCapabilities: selectedMachineCapabilitiesSnapshot?.response,
    }), [machineAgents, selectedMachineCapabilitiesSnapshot]);

    // The Agent this picker describes is the OPERATIONAL runtime carrier, not
    // the bundled catalog id. `staticAgentId` is null for every installed
    // Agent, and `canAgentResume`'s non-bundled branch additionally needs the
    // current projection's Agent capabilities — so the picker could never
    // appear for one. `useResumeCapabilityOptions` is the single owner of that
    // capability read; the bundled fallback order is preserved exactly.
    const resumeAgentId = staticAgentId ?? params.runtimeCarrierAgentId ?? null;
    const { resumeCapabilityOptions: resumeCapabilityOptionsResolved } = useResumeCapabilityOptions({
        agentId: resumeAgentId,
        machineId: params.selectedMachineId,
        serverId: params.capabilityServerId,
        settings: params.settings,
        pluginSettings: params.pluginSettings,
        load: machineProbesEnabled,
    });

    const showResumePicker = React.useMemo(() => {
        return resumeAgentId !== null && canAgentResume(resumeAgentId, resumeCapabilityOptionsResolved);
    }, [resumeAgentId, resumeCapabilityOptionsResolved]);

    const wizardInstallableDeps = React.useMemo(() => {
        const results = selectedMachineCapabilitiesSnapshot?.response.results;
        return selectedInstallables.map((entry) => {
            const depStatus = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            return { entry, depStatus, detectResult };
        });
    }, [
        selectedInstallables,
        selectedMachineCapabilitiesSnapshot,
    ]);

    const isAgentSelectable = React.useCallback((agentId: AgentId): boolean => {
        return isAgentSelectableForNewSession({
            agentId,
            machineAgentsById,
        });
    }, [machineAgentsById]);

    const isBackendEntrySelectable = React.useCallback((entry: ResolvedBackendCatalogEntry): boolean => {
        return isBackendEntrySelectableForNewSession({
            entry,
            machineAgentsById,
        });
    }, [machineAgentsById]);

    const getBackendEntryUnavailabilityReason = React.useCallback((entry: ResolvedBackendCatalogEntry) => {
        return resolveBackendEntryUnavailabilityReasonForNewSession({
            entry,
            machineAgentsById,
        });
    }, [machineAgentsById]);

    const readPresenceMachines = React.useCallback(() => [params.selectedMachine], [params.selectedMachine]);
    const readReachability = React.useCallback((nowMs: number) => (
        params.selectedMachineId && params.selectedMachine
            ? resolveMachineReachability(scope, params.selectedMachine, nowMs) : 'unknown'
    ), [params.selectedMachineId, params.selectedMachine, scope]);
    const presenceTargets = React.useMemo(() => [{ serverId: scope?.serverId, machineIds: params.selectedMachineId ? [params.selectedMachineId] : [] }],
        [scope?.serverId, params.selectedMachineId]);
    const selectedMachineReachability = useMachinePresenceSnapshot(readPresenceMachines, readReachability, presenceTargets);
    const selectedMachineOnline = selectedMachineReachability === 'reachable';

    const selectedMachineSpawnReadiness = React.useMemo(() => {
        const rpcAvailable =
            selectedMachineCapabilities.status === 'loaded'
                ? true
                : selectedMachineCapabilities.status === 'loading'
                    ? 'probing'
                    : selectedMachineCapabilities.status === 'error'
                        ? 'unknown'
                        : selectedMachineOnline
                            ? 'unknown'
                            : undefined;
        const keyAvailable = rpcAvailable === true
            ? true
            : rpcAvailable === 'probing'
                ? 'probing'
                : rpcAvailable === 'unknown'
                    ? 'unknown'
                    : undefined;
        return resolveMachineSpawnReadiness({
            selectedMachineId: params.selectedMachineId,
            machine: params.selectedMachine,
            scope,
            rpcAvailable,
            keyAvailable,
            machineReachable: selectedMachineOnline,
            requireExactSpawnReadiness: true,
        });
    }, [
        params.selectedMachine,
        params.selectedMachineId,
        selectedMachineCapabilities.status,
        selectedMachineOnline,
        selectedMachineReachability,
        scope,
    ]);

    const initialRefreshKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        return JSON.stringify([serverId, machineId, cacheKeySalt, systemRequest]);
    }, [params.capabilityServerId, params.selectedMachineId, cacheKeySalt, systemRequest]);

    const initialRefreshHandledKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!machineProbesEnabled) return;
        if (!initialRefreshKey) return;
        if (!selectedMachineOnline) {
            initialRefreshHandledKeyRef.current = null;
            return;
        }

        // Guard against effect churn (e.g. refresh callback identity changes due to
        // upstream server switching / hot reload / hook rebuilds). The initial “probe wave”
        // should run once per daemon-scoped cache namespace while the machine remains online.
        if (initialRefreshHandledKeyRef.current === initialRefreshKey) return;
        initialRefreshHandledKeyRef.current = initialRefreshKey;

        return runAfterInteractionsWithFallback(() => {
            refreshSelectedMachineCapabilities();
        });
    }, [initialRefreshKey, machineProbesEnabled, refreshSelectedMachineCapabilities, selectedMachineOnline]);

    const onWindowsTerminalIntent = React.useCallback(() => {
        if (!machineProbesEnabled || !selectedMachineOnline) return;
        refreshSelectedMachineCapabilities({ request: { requests: [{ id: 'tool.windowsTerminal' }] } });
    }, [machineProbesEnabled, refreshSelectedMachineCapabilities, selectedMachineOnline]);

    const getCompatibleProfileBackendEntries = React.useCallback((profile: AIBackendProfile) => {
        // Fail closed: malformed/untyped projection entries must not crash profile availability resolution.
        return params.resolvedBackendEntries.filter((entry) => (
            entry.backendTarget
            && isProfileCompatibleWithBackendTarget(profile, entry.backendTarget)
        ));
    }, [params.resolvedBackendEntries]);

    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): ProfileAvailability => {
        return resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: getCompatibleProfileBackendEntries(profile),
            machineAgentsById,
        });
    }, [getCompatibleProfileBackendEntries, machineAgentsById]);

    const profileAvailabilityById = React.useMemo(() => {
        const map = new Map<string, ProfileAvailability>();
        for (const profile of params.allProfiles) {
            map.set(profile.id, isProfileAvailable(profile));
        }
        return map;
    }, [isProfileAvailable, params.allProfiles]);

    const selectedMachineIsWindows = params.selectedMachine?.metadata?.platform === 'win32';
    const windowsTerminalAvailable = React.useMemo(() => resolveWindowsTerminalAvailable({
        targetIsWindows: selectedMachineIsWindows,
        response: selectedMachineCapabilitiesSnapshot?.response,
    }), [selectedMachineCapabilitiesSnapshot, selectedMachineIsWindows]);

    return {
        cliAvailability,
        selectedMachineOnline,
        selectedMachineReachability,
        selectedMachineCapabilities,
        capabilitiesCacheKeySalt: cacheKeySalt,
        selectedMachineCapabilitiesSnapshot,
        selectedMachineSpawnReadiness,
        selectedAgentSettingsReady,
        tmuxRequested,
        showResumePicker,
        wizardInstallableDeps,
        machineAgents,
        machineAgentsById,
        getBackendEntryMachineAgent,
        isAgentSelectable,
        isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        windowsTerminalAvailable,
        onWindowsTerminalIntent,
    };
}
