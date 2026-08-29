import * as React from 'react';

import {
    canSelectAgentWithoutDetectedCli,
    getAgentCore,
    getAgentBehavior,
    getAgentResumeExperimentsFromSettings,
    getNewSessionRelevantInstallableDepKeys,
    isBundledAgentId,
    type AgentId,
} from '@/agents/catalog/catalog';
import {
    type ResolvedBackendCatalogEntry,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { canAgentResume } from '@/agents/runtime/resumeCapabilities';
import {
    isAgentSelectableForNewSession,
    isBackendEntrySelectableForNewSession,
    resolveBackendEntryUnavailabilityReasonForNewSession,
    resolveProfileAvailabilityForNewSession,
} from '@/components/sessions/new/modules/newSessionAgentSelection';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { PersistedBackendTargetRefV2, PluginProjectionV2 } from '@happier-dev/protocol';
import type { BackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';

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

export function resolveNewSessionDeclarationAvailabilityFacts(params: Readonly<{
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    selectedMachineId: string | null;
    settings: Settings;
    resumeSessionId: string | null;
    externalSessionsFeatureEnabled: boolean;
    backendNewSessionOptionStateByTargetKey: Readonly<BackendNewSessionOptionStateByTargetKey>;
}>): Readonly<{
    installableDepKeyCountByAgentId: Readonly<Partial<Record<AgentId, number>>>;
    selectableWithoutCliByAgentId: Readonly<Partial<Record<AgentId, boolean>>>;
}> {
    const installableDepKeyCountByAgentId: Partial<Record<AgentId, number>> = {};
    const selectableWithoutCliByAgentId: Partial<Record<AgentId, boolean>> = {};
    for (const entry of params.resolvedBackendEntries) {
        if (entry.kind === 'configuredBackend') continue;
        const id = entry.agentId;
        if (!id || Object.prototype.hasOwnProperty.call(installableDepKeyCountByAgentId, id)) continue;
        const experiments = getAgentResumeExperimentsFromSettings(id, params.settings, params.selectedMachineId);
        installableDepKeyCountByAgentId[id] = getNewSessionRelevantInstallableDepKeys({
            agentId: id,
            settings: params.settings,
            experiments,
            resumeSessionId: params.resumeSessionId ?? '',
            machineId: params.selectedMachineId,
        }).length;
        const supportsExternalSessionBrowse = isBundledAgentId(id)
            && params.externalSessionsFeatureEnabled
            && getAgentCore(id).sessionStorage.direct === true
            && typeof getAgentBehavior(id).externalSessions?.browse?.getSourceOptions === 'function';
        selectableWithoutCliByAgentId[id] = supportsExternalSessionBrowse || canSelectAgentWithoutDetectedCli({
            agentId: id,
            settings: params.settings,
            machineId: params.selectedMachineId,
            agentOptionState: params.backendNewSessionOptionStateByTargetKey[entry.backendTargetKey] ?? null,
        });
    }
    return { installableDepKeyCountByAgentId, selectableWithoutCliByAgentId };
}

export function useNewSessionAvailabilityState(params: Readonly<{
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    capabilityServerId: string;
    externalSessionsFeatureEnabled: boolean;
    settings: Settings;
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
    dismissedCliWarnings: DismissedCliWarnings | null | undefined;
    setDismissedCliWarnings: (next: DismissedCliWarnings) => void;
    allProfiles: ReadonlyArray<AIBackendProfile>;
}>) {
    const staticAgentId = params.staticAgentId ?? params.agentType ?? null;
    const behaviorAgentId = resolveNewSessionBehaviorAgentId({
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        staticAgentId,
        agentType: params.agentType,
    });
    const cliAgentIds = React.useMemo(() => {
        const out: string[] = [];
        for (const entry of params.resolvedBackendEntries) {
            if (entry.kind === 'configuredBackend') continue;
            const agentId = entry.agentId.trim();
            if (!agentId || out.includes(agentId)) continue;
            out.push(agentId);
        }
        return out;
    }, [params.resolvedBackendEntries]);
    const automaticLoginStatusAgentIds = React.useMemo(() => {
        const out: string[] = [];
        for (const entry of params.resolvedBackendEntries) {
            if (entry.kind === 'configuredBackend') continue;
            const agentId = entry.agentId.trim();
            if (!agentId || !entry.cliAuthBackgroundCheckSafe || out.includes(agentId)) continue;
            out.push(agentId);
        }
        return out;
    }, [params.resolvedBackendEntries]);
    const automaticLoginStatusAgentIdsKey = React.useMemo(
        () => stableJsonStringify(automaticLoginStatusAgentIds),
        [automaticLoginStatusAgentIds],
    );
    const cliAvailability = useCLIDetection(params.selectedMachineId, {
        autoDetect: false,
        agentIds: cliAgentIds,
        includeLoginStatus: automaticLoginStatusAgentIds.length > 0,
        includeLoginStatusForAgentIds: automaticLoginStatusAgentIds,
        serverId: params.capabilityServerId,
    });
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
    });

    const showResumePicker = React.useMemo(() => {
        return resumeAgentId !== null && canAgentResume(resumeAgentId, resumeCapabilityOptionsResolved);
    }, [resumeAgentId, resumeCapabilityOptionsResolved]);

    const wizardInstallableDeps = React.useMemo(() => {
        if (!params.selectedMachineId || !behaviorAgentId) return [];

        const experiments = getAgentResumeExperimentsFromSettings(behaviorAgentId, params.settings, params.selectedMachineId);
        const relevantKeys = getNewSessionRelevantInstallableDepKeys({
            agentId: behaviorAgentId,
            settings: params.settings,
            experiments,
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
        params.settings,
        selectedMachineCapabilitiesSnapshot,
        behaviorAgentId,
    ]);

    const declarationAvailabilityFacts = React.useMemo(() => resolveNewSessionDeclarationAvailabilityFacts({
        resolvedBackendEntries: params.resolvedBackendEntries,
        selectedMachineId: params.selectedMachineId,
        settings: params.settings,
        resumeSessionId: params.resumeSessionId,
        externalSessionsFeatureEnabled: params.externalSessionsFeatureEnabled,
        backendNewSessionOptionStateByTargetKey: params.backendNewSessionOptionStateByTargetKey,
    }), [
        params.backendNewSessionOptionStateByTargetKey,
        params.externalSessionsFeatureEnabled,
        params.resolvedBackendEntries,
        params.resumeSessionId,
        params.selectedMachineId,
        params.settings,
    ]);
    const { installableDepKeyCountByAgentId, selectableWithoutCliByAgentId } = declarationAvailabilityFacts;

    const isAgentSelectable = React.useCallback((agentId: AgentId): boolean => {
        return isAgentSelectableForNewSession({
            agentId,
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            authStatusById: cliAvailability.authStatus,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.authStatus, cliAvailability.available, cliAvailability.timestamp, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

    const isBackendEntrySelectable = React.useCallback((entry: ResolvedBackendCatalogEntry): boolean => {
        return isBackendEntrySelectableForNewSession({
            entry,
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            authStatusById: cliAvailability.authStatus,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.authStatus, cliAvailability.available, cliAvailability.timestamp, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

    const getBackendEntryUnavailabilityReason = React.useCallback((entry: ResolvedBackendCatalogEntry) => {
        return resolveBackendEntryUnavailabilityReasonForNewSession({
            entry,
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            authStatusById: cliAvailability.authStatus,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.authStatus, cliAvailability.available, cliAvailability.timestamp, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

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
        return `${serverId}:${machineId}:${automaticLoginStatusAgentIdsKey}`;
    }, [automaticLoginStatusAgentIdsKey, params.capabilityServerId, params.selectedMachineId]);

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

    const [hiddenCliWarningKeys, setHiddenCliWarningKeys] = React.useState<Record<string, boolean>>(() => ({
        ...readTemporaryHiddenCliWarningKeys(params.selectedMachineId),
    }));
    React.useEffect(() => {
        setHiddenCliWarningKeys({
            ...readTemporaryHiddenCliWarningKeys(params.selectedMachineId),
        });
    }, [params.selectedMachineId]);

    const isCliBannerDismissed = React.useCallback((agentId: AgentId): boolean => {
        const warningKey = getAgentCore(agentId)?.cli.detectKey;
        // No bundled CLI detect key means there is no CLI banner to dismiss.
        if (!warningKey) return true;
        if (hiddenCliWarningKeys[warningKey] === true) return true;
        return isCliWarningDismissed({ dismissed: params.dismissedCliWarnings, machineId: params.selectedMachineId, warningKey });
    }, [hiddenCliWarningKeys, params.dismissedCliWarnings, params.selectedMachineId]);

    const dismissCliBanner = React.useCallback((agentId: AgentId, scope: 'machine' | 'global' | 'temporary') => {
        const warningKey = getAgentCore(agentId)?.cli.detectKey;
        if (!warningKey) return;
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
        // Fail closed: malformed/untyped projection entries must not crash profile availability resolution.
        return params.resolvedBackendEntries.filter((entry) => (
            entry.backendTarget
            && isProfileCompatibleWithBackendTarget(profile, entry.backendTarget)
        ));
    }, [params.resolvedBackendEntries]);

    const isProfileAvailable = React.useCallback((profile: AIBackendProfile): ProfileAvailability => {
        return resolveProfileAvailabilityForNewSession({
            candidateBackendEntries: getCompatibleProfileBackendEntries(profile),
            detectionTimestamp: cliAvailability.timestamp,
            availabilityById: cliAvailability.available,
            authStatusById: cliAvailability.authStatus,
            installableDepKeyCountByAgentId,
            selectableWithoutCliByAgentId,
        });
    }, [cliAvailability.authStatus, cliAvailability.available, cliAvailability.timestamp, getCompatibleProfileBackendEntries, installableDepKeyCountByAgentId, selectableWithoutCliByAgentId]);

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
        selectedMachineSpawnReadiness,
        tmuxRequested,
        showResumePicker,
        wizardInstallableDeps,
        installableDepKeyCountByAgentId,
        selectableWithoutCliByAgentId,
        isAgentSelectable,
        isBackendEntrySelectable,
        getBackendEntryUnavailabilityReason,
        isCliBannerDismissed,
        dismissCliBanner,
        getCompatibleProfileBackendEntries,
        profileAvailabilityById,
        selectedMachineIsWindows,
        windowsTerminalAvailable,
    };
}
