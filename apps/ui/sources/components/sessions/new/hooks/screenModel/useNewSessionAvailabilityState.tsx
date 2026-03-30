import * as React from 'react';

import {
    buildResumeCapabilityOptionsFromUiState,
    canSelectAgentWithoutDetectedCli,
    getAgentCore,
    getAgentResumeExperimentsFromSettings,
    getNewSessionRelevantInstallableDepKeys,
    type AgentId,
} from '@/agents/catalog/catalog';
import {
    resolveProviderAgentIdForBackendTarget,
    type ResolvedBackendCatalogEntry,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { ensureAgentInstallablesBackground } from '@/capabilities/ensureAgentInstallablesBackground';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useCLIDetection } from '@/hooks/auth/useCLIDetection';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { isProfileCompatibleWithBackendTarget } from '@/sync/domains/profiles/profileCompatibility';
import {
    applyCliWarningDismissal,
    isCliWarningDismissed,
    type DismissedCliWarnings,
} from '@/agents/runtime/cliWarnings';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import { isAgentSelectableForNewSession, resolveProfileAvailabilityForNewSession } from '@/components/sessions/new/modules/newSessionAgentSelection';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

type ProfileAvailability = Readonly<{ available: boolean; reason?: string }>;

const TEMPORARY_CLI_WARNING_GLOBAL_MACHINE_KEY = '__global__';
const temporaryHiddenCliWarningKeysByMachineId: Record<string, Readonly<Record<string, boolean>>> = {};

function readTemporaryHiddenCliWarningKeys(machineId: string | null | undefined): Readonly<Record<string, boolean>> {
    const key = machineId ?? TEMPORARY_CLI_WARNING_GLOBAL_MACHINE_KEY;
    return temporaryHiddenCliWarningKeysByMachineId[key] ?? {};
}

function writeTemporaryHiddenCliWarningKey(machineId: string | null | undefined, warningKey: string): void {
    const key = machineId ?? TEMPORARY_CLI_WARNING_GLOBAL_MACHINE_KEY;
    const existing = temporaryHiddenCliWarningKeysByMachineId[key] ?? {};
    temporaryHiddenCliWarningKeysByMachineId[key] = { ...existing, [warningKey]: true };
}

export function useNewSessionAvailabilityState(params: Readonly<{
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    capabilityServerId: string;
    settings: Settings;
    agentType: AgentId;
    resumeSessionId: string | null;
    enabledAgentIds: ReadonlyArray<AgentId>;
    agentNewSessionOptionStateByAgentId: Readonly<Record<string, Record<string, unknown>>>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    machines: ReadonlyArray<Machine>;
    dismissedCliWarnings: DismissedCliWarnings | null | undefined;
    setDismissedCliWarnings: (next: DismissedCliWarnings) => void;
    allProfiles: ReadonlyArray<AIBackendProfile>;
}>) {
    const cliAvailability = useCLIDetection(params.selectedMachineId, { autoDetect: false, serverId: params.capabilityServerId });
    const { state: selectedMachineCapabilities, refresh: refreshSelectedMachineCapabilities } = useDaemonScopedMachineCapabilitiesCache({
        machineId: params.selectedMachineId,
        serverId: params.capabilityServerId,
        daemonStateVersion: params.selectedMachine?.daemonStateVersion ?? 0,
        enabled: false,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
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

    const tmuxRequested = React.useMemo(() => {
        return Boolean(resolveTerminalSpawnOptions({
            settings: params.settings,
            machineId: params.selectedMachineId,
        }));
    }, [params.selectedMachineId, params.settings]);

    const resumeCapabilityOptionsResolved = React.useMemo(() => {
        return buildResumeCapabilityOptionsFromUiState({
            settings: params.settings,
            results: selectedMachineCapabilitiesSnapshot?.response.results,
        });
    }, [params.settings, selectedMachineCapabilitiesSnapshot]);

    const showResumePicker = React.useMemo(() => {
        return canAgentResume(params.agentType, resumeCapabilityOptionsResolved);
    }, [params.agentType, resumeCapabilityOptionsResolved]);

    const wizardInstallableDeps = React.useMemo(() => {
        if (!params.selectedMachineId) return [];

        const experiments = getAgentResumeExperimentsFromSettings(params.agentType, params.settings);
        const relevantKeys = getNewSessionRelevantInstallableDepKeys({
            agentId: params.agentType,
            settings: params.settings,
            experiments,
            resumeSessionId: params.resumeSessionId ?? '',
        });
        if (relevantKeys.length === 0) return [];

        const entries = getInstallablesRegistryEntries().filter((entry) => relevantKeys.includes(entry.key));
        const results = selectedMachineCapabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const depStatus = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            return { entry, depStatus, detectResult };
        });
    }, [
        params.agentType,
        params.resumeSessionId,
        params.selectedMachineId,
        params.settings,
        selectedMachineCapabilitiesSnapshot,
    ]);

    const installableDepKeyCountByAgentId = React.useMemo(() => {
        const out: Partial<Record<AgentId, number>> = {};
        for (const id of params.enabledAgentIds) {
            const experiments = getAgentResumeExperimentsFromSettings(id, params.settings);
            const relevantKeys = getNewSessionRelevantInstallableDepKeys({
                agentId: id,
                settings: params.settings,
                experiments,
                resumeSessionId: params.resumeSessionId ?? '',
            });
            out[id] = relevantKeys.length;
        }
        return out;
    }, [params.enabledAgentIds, params.resumeSessionId, params.settings]);

    const selectableWithoutCliByAgentId = React.useMemo(() => {
        const out: Partial<Record<AgentId, boolean>> = {};
        for (const id of params.enabledAgentIds) {
            out[id] = canSelectAgentWithoutDetectedCli({
                agentId: id,
                settings: params.settings,
                agentOptionState: params.agentNewSessionOptionStateByAgentId[id] ?? null,
            });
        }
        return out;
    }, [params.agentNewSessionOptionStateByAgentId, params.enabledAgentIds, params.settings]);

    const isAgentSelectable = React.useCallback((agentId: AgentId): boolean => {
        return isAgentSelectableForNewSession({
            agentId,
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.available, cliAvailability.timestamp, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

    const isBackendEntrySelectable = React.useCallback((entry: ResolvedBackendCatalogEntry): boolean => {
        if (entry.family === 'configuredAcpBackend') {
            return true;
        }
        return isAgentSelectable(entry.builtInAgentId ?? resolveProviderAgentIdForBackendTarget(entry.target));
    }, [isAgentSelectable]);

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

    const initialRefreshKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        return `${serverId}:${machineId}`;
    }, [params.capabilityServerId, params.selectedMachineId]);

    const initialRefreshHandledKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!initialRefreshKey) return;
        if (!selectedMachineOnline) {
            initialRefreshHandledKeyRef.current = null;
            return;
        }

        // Guard against effect churn (e.g. refresh callback identity changes due to
        // upstream server switching / hot reload / hook rebuilds). The initial “probe wave”
        // should run once per (serverId,machineId) while the machine remains online.
        if (initialRefreshHandledKeyRef.current === initialRefreshKey) return;
        initialRefreshHandledKeyRef.current = initialRefreshKey;

        return runAfterInteractionsWithFallback(() => {
            // Bypass daemon-side probe caches so newly installed CLIs become selectable immediately.
            cliAvailability.refresh({ bypassCache: true });
            refreshSelectedMachineCapabilities();
        });
    }, [cliAvailability.refresh, initialRefreshKey, refreshSelectedMachineCapabilities, selectedMachineOnline]);

    React.useEffect(() => {
        if (!params.selectedMachineId) return;
        if (wizardInstallableDeps.length === 0) return;

        const machine = params.machines.find((candidate) => candidate.id === params.selectedMachineId);
        if (!machine || !isMachineOnline(machine)) return;
        const selectedMachineId = params.selectedMachineId;

        return runAfterInteractionsWithFallback(() => {
            fireAndForget(
                ensureAgentInstallablesBackground({
                    agentId: params.agentType,
                    machineId: selectedMachineId,
                    serverId: params.capabilityServerId,
                    settings: params.settings,
                    resumeSessionId: params.resumeSessionId,
                }),
                { tag: `NewSessionScreenModel.installables.ensure.${params.agentType}` },
            );
        });
    }, [
        params.agentType,
        params.capabilityServerId,
        params.machines,
        params.resumeSessionId,
        params.selectedMachineId,
        params.settings,
        wizardInstallableDeps.length,
    ]);

    const [hiddenCliWarningKeys, setHiddenCliWarningKeys] = React.useState<Record<string, boolean>>(() => ({
        ...readTemporaryHiddenCliWarningKeys(params.selectedMachineId),
    }));
    React.useEffect(() => {
        setHiddenCliWarningKeys({
            ...readTemporaryHiddenCliWarningKeys(params.selectedMachineId),
        });
    }, [params.selectedMachineId]);

    const isCliBannerDismissed = React.useCallback((agentId: AgentId): boolean => {
        const warningKey = getAgentCore(agentId).cli.detectKey;
        if (hiddenCliWarningKeys[warningKey] === true) return true;
        return isCliWarningDismissed({ dismissed: params.dismissedCliWarnings, machineId: params.selectedMachineId, warningKey });
    }, [hiddenCliWarningKeys, params.dismissedCliWarnings, params.selectedMachineId]);

    const dismissCliBanner = React.useCallback((agentId: AgentId, scope: 'machine' | 'global' | 'temporary') => {
        const warningKey = getAgentCore(agentId).cli.detectKey;
        if (scope === 'temporary') {
            writeTemporaryHiddenCliWarningKey(params.selectedMachineId, warningKey);
            setHiddenCliWarningKeys((prev) => ({ ...prev, [warningKey]: true }));
            return;
        }
        params.setDismissedCliWarnings(
            applyCliWarningDismissal({
                dismissed: params.dismissedCliWarnings,
                machineId: params.selectedMachineId,
                warningKey,
                scope,
            }),
        );
    }, [params.dismissedCliWarnings, params.selectedMachineId, params.setDismissedCliWarnings]);

    const getCompatibleProfileBackendEntries = React.useCallback((profile: AIBackendProfile) => {
        return params.resolvedBackendEntries.filter((entry) => isProfileCompatibleWithBackendTarget(profile, entry.target));
    }, [params.resolvedBackendEntries]);

    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): ProfileAvailability => {
        return resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: getCompatibleProfileBackendEntries(profile),
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.available, cliAvailability.timestamp, getCompatibleProfileBackendEntries, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

    const profileAvailabilityById = React.useMemo(() => {
        const map = new Map<string, ProfileAvailability>();
        for (const profile of params.allProfiles) {
            map.set(profile.id, isProfileAvailable(profile));
        }
        return map;
    }, [isProfileAvailable, params.allProfiles]);

    const selectedMachineIsWindows = params.selectedMachine?.metadata?.platform === 'win32';
    const windowsTerminalAvailable = React.useMemo(() => {
        if (!selectedMachineIsWindows) return false;
        const result = selectedMachineCapabilitiesSnapshot?.response.results['tool.windowsTerminal'];
        if (result?.ok !== true) {
            return false;
        }
        const data = result.data;
        const available = data && typeof data === 'object' && 'available' in data ? data.available : false;
        return available === true;
    }, [selectedMachineCapabilitiesSnapshot, selectedMachineIsWindows]);

    return {
        cliAvailability,
        selectedMachineCapabilities,
        selectedMachineCapabilitiesSnapshot,
        tmuxRequested,
        showResumePicker,
        wizardInstallableDeps,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        isAgentSelectable,
        isBackendEntrySelectable,
        isCliBannerDismissed,
        dismissCliBanner,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        windowsTerminalAvailable,
    };
}
