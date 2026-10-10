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
import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
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
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
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
    /** Demand comes from the picker/popover visibility owner, never mount. */
    agentInventoryDemanded?: boolean;
    capabilityServerId: string;
    externalSessionsFeatureEnabled: boolean;
    settings: Settings;
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
    const staticAgentId = params.staticAgentId ?? params.agentType ?? null;
    const behaviorAgentId = resolveNewSessionBehaviorAgentId({
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        staticAgentId,
        agentType: params.agentType,
    });
    const selectedAgentSettingsReady = params.pluginSettingsReadiness === null
        || params.pluginSettingsReadiness === undefined
        || params.pluginSettingsReadiness.ready;
    // Admission needs the selected Agent's facts even while the full picker stays closed.
    const selectedInventoryAgentId = params.selectedBackendEntry && params.selectedBackendEntry.kind !== 'configuredBackend'
        ? params.selectedBackendEntry.agentId : undefined;
    const machineAgents = useMachineAgents({
        machineId: params.selectedMachineId,
        serverId: params.capabilityServerId,
        agentId: params.agentInventoryDemanded === true ? undefined : selectedInventoryAgentId,
        load: params.agentInventoryDemanded === true || Boolean(selectedInventoryAgentId),
    });
    const machineAgentsById = React.useMemo(() => Object.fromEntries(machineAgents.agents.map((agent) => [agent.agentId, agent])), [machineAgents.agents]);
    const systemRequest = React.useMemo(() => ({ requests: [
        { id: 'tool.tmux' as const }, { id: 'tool.windowsTerminal' as const },
        ...getInstallablesRegistryEntries({ pluginProjection: params.pluginProjectionV2 ?? undefined }).map((entry) => ({ id: entry.capabilityId })),
    ] }), [params.pluginProjectionV2]);
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

    const tmuxRequested = React.useMemo(() => {
        return resolveTerminalHost({
            settings: params.settings,
            machineId: params.selectedMachineId,
        }) === 'tmux';
    }, [params.selectedMachineId, params.settings]);

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
    });

    const showResumePicker = React.useMemo(() => {
        return resumeAgentId !== null && canAgentResume(resumeAgentId, resumeCapabilityOptionsResolved);
    }, [resumeAgentId, resumeCapabilityOptionsResolved]);

    const wizardInstallableDeps = React.useMemo(() => {
        if (!params.selectedMachineId || !behaviorAgentId) return [];

        const experiments = getAgentResumeExperimentsFromSettings(behaviorAgentId, params.settings, params.selectedMachineId, params.pluginSettings);
        const relevantKeys = getNewSessionRelevantInstallableDepKeys({
            agentId: behaviorAgentId,
            settings: params.settings,
            experiments,
            pluginSettings: params.pluginSettings,
            resumeSessionId: params.resumeSessionId ?? '',
            machineId: params.selectedMachineId,
        });
        if (relevantKeys.length === 0) return [];

        const entries = getInstallablesRegistryEntries({
            pluginProjection: params.pluginProjectionV2 ?? undefined,
        }).filter((entry) => relevantKeys.includes(entry.key));
        const results = selectedMachineCapabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const depStatus = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            return { entry, depStatus, detectResult };
        });
    }, [
        params.resumeSessionId,
        params.pluginProjectionV2,
        params.selectedMachineId,
        params.pluginSettings,
        params.settings,
        selectedMachineCapabilitiesSnapshot,
        behaviorAgentId,
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

    const selectedMachineOnline = React.useMemo(() => {
        if (!params.selectedMachineId) return false;
        const machine = params.selectedMachine;
        if (!machine) return false;
        return isMachineOnline(machine);
    }, [
        params.selectedMachineId,
        params.selectedMachine?.active,
        params.selectedMachine?.activeAt,
        params.selectedMachine?.revokedAt,
    ]);

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
            rpcAvailable,
            keyAvailable,
            requireExactSpawnReadiness: true,
        });
    }, [
        params.selectedMachine,
        params.selectedMachineId,
        selectedMachineCapabilities.status,
        selectedMachineOnline,
    ]);

    const initialRefreshKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        return JSON.stringify([serverId, machineId, cacheKeySalt]);
    }, [params.capabilityServerId, params.selectedMachineId, cacheKeySalt]);

    const initialRefreshHandledKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
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
    }, [initialRefreshKey, refreshSelectedMachineCapabilities, selectedMachineOnline]);

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
        selectedMachineCapabilities,
        selectedMachineCapabilitiesSnapshot,
        selectedMachineSpawnReadiness,
        selectedAgentSettingsReady,
        tmuxRequested,
        showResumePicker,
        wizardInstallableDeps,
        machineAgents,
        machineAgentsById,
        isAgentSelectable,
        isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        windowsTerminalAvailable,
    };
}
