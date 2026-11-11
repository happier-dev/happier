import * as React from 'react';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';

import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { stripBackendTargetSourceKind } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { resolveAgentScopedPluginSettingPresentation } from '@/agents/registry/agentScopedPluginSettingsDeclarations';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { supportsDirectTranscriptStorageForNewSession } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useAiLaunchProfilesWithReadState } from '@/sync/store/useAiLaunchProfiles';
import { useAgentUiSettings } from '@/agents/catalog/useAgentUiSettings';
import { useSetting, useServerScopedMachine } from '@/sync/domains/state/storage';
import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import { useObservedMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { findMachineAgentInventoryItemForTargetV1, resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text';
import { resolveWindowsTerminalAvailable } from '@/capabilities/windowsTerminalAvailability';

import type {
    SessionAuthoringAgentTargetOption,
    SessionAuthoringConnectedServicesContext,
    SessionAuthoringControlFacts,
    SessionAuthoringMcpContext,
} from './sessionAuthoringFieldControls';

/**
 * The host-owned facts the controlled Session-authoring controls consume, for a
 * surface that authors a selection against one exact Machine.
 *
 * `SessionAuthoringControls` is deliberately a pure projection: a field whose
 * option source was never contributed renders as explicitly unavailable. New
 * Session contributes these facts from its own screen model, so every other
 * authoring host — the Workflow editor and the Automation wrappers that compose
 * it — needs the same facts from the same catalogs, or its Agent picker offers
 * nothing while the strict Workflow schema still requires an effective Agent.
 *
 * This adapter is that one owner. It resolves nothing new: the selectable Agent
 * targets come from the incumbent backend catalog for the exact Machine's daemon
 * projection, the profiles come from the Account settings collection, and the
 * Windows launch controls come from that Machine's reported platform. It is a
 * read-only projection — it never persists, remembers or applies a selection.
 */
export function useSessionAuthoringControlFacts(params: Readonly<{
    /** The exact Machine this selection will run on; `null` while unresolved. */
    machineId: string | null;
    serverId?: string | null;
    /** The project folder on that Machine; with the Machine it scopes the MCP preview. */
    directory?: string | null;
}>): SessionAuthoringControlFacts {
    const { machineId } = params;
    const serverId = params.serverId ?? null;
    const directory = params.directory?.trim() ?? '';
    const selectedMachine = useServerScopedMachine(serverId, machineId);
    const preferredLanguage = getPreferredLanguage();
    const { snapshot: acpCatalog } = useAcpCatalogForServer(params.serverId);
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const { lastUsedAgent, lastUsedBackendTarget } = useLastUsedBackendSelection();
    const useProfiles = useSetting('useProfiles') === true;
    // The same scoped feature decisions New Session consults for this spawn target.
    const spawnFeatureScope = React.useMemo(
        () => (serverId === null ? undefined : { scopeKind: 'spawn' as const, serverId }),
        [serverId],
    );
    const directTranscriptsEnabled = useFeatureEnabled('sessions.direct', spawnFeatureScope);

    const daemonProjection = useDaemonMergedProjectionInputs({
        sections: ['agentsById', 'settingsById', 'familiesById.pluginUi', 'resourcesById'],
        machineId,
        serverId,
        enabled: machineId !== null,
    });
    const projectionInputs = daemonProjection.phase === 'ready' ? daemonProjection.inputs : null;
    const pluginUiProjection = projectionInputs?.pluginUiProjection ?? null;
    const localizePluginText = usePluginLocalizedTextResolver({ projection: pluginUiProjection, locale: preferredLanguage });

    const backendEntries = React.useMemo(() => getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
            acpCatalogSnapshot: acpCatalog?.catalog,
            backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: projectionInputs?.mergedBackendProjectionById ?? null,
            ...(projectionInputs?.discoveredBackendIds === undefined
                ? {}
                : { discoveredBackendIds: projectionInputs.discoveredBackendIds }),
        }), [acpCatalog, backendEnabledByTargetKey, projectionInputs]);
    const settings = useAgentUiSettings({ agentIds: backendEntries.map(entry => entry.agentId), machineId, domain: 'transcriptStorage' });
    // Readiness already produced for this Machine (installed, signed in or a
    // connected default): observed only, so an unopened control never probes.
    const machineAgents = useObservedMachineAgents({ serverId, machineId }).agents;
    const agentTargets = React.useMemo<readonly SessionAuthoringAgentTargetOption[]>(() => {
        const options: SessionAuthoringAgentTargetOption[] = [];
        for (const entry of backendEntries) {
            // A configured backend with no machine projection has no resolvable
            // Agent contribution. Offering it would author a target the ingress
            // normalizer rejects, so it is left out rather than guessed.
            const target = resolveAgentExecutionTargetForBackendTarget({
                // The retained `sourceKind` carrier is not part of the strict
                // target vocabulary; the canonical stripper owns removing it.
                backendTarget: stripBackendTargetSourceKind(entry.backendTarget),
                daemonMergedProjectionInputs: projectionInputs,
            });
            if (target === null) continue;
            const runtimeBackendModeDescriptor = resolveAgentUiBehavior(entry.agentId, machineId)
                .newSession?.runtimeDescriptorV1?.backendMode;
            const runtimeBackendModePresentation = runtimeBackendModeDescriptor
                ? resolveAgentScopedPluginSettingPresentation({
                    agentId: entry.agentId,
                    setting: runtimeBackendModeDescriptor.settingKey,
                    projectionInputs,
                    localize: localizePluginText,
                })
                : null;
            const allowedRuntimeBackendModes = runtimeBackendModeDescriptor
                ? new Set(runtimeBackendModeDescriptor.values)
                : null;
            const runtimeBackendModeOptions = runtimeBackendModePresentation?.options.flatMap((option) => {
                const value = typeof option.value === 'string' ? option.value : null;
                if (!value || !allowedRuntimeBackendModes?.has(value)) return [];
                return [{
                    id: value,
                    label: option.title,
                    ...(option.description === undefined ? {} : { subtitle: option.description }),
                }];
            }) ?? [];
            const machineAgent = findMachineAgentInventoryItemForTargetV1(machineAgents, target);
            // Retained facts of a Machine not answering now decide nothing.
            const readiness = machineAgent && !machineAgent.stale
                ? resolveMachineAgentExecutionStateV1({ inventoryState: machineAgent.state }) : undefined;
            options.push({
                pickerEntry: entry,
                ...(readiness === undefined ? {} : { readiness }),
                ...(machineAgent ? { machineAgent } : {}),
                id: entry.backendTargetKey,
                label: entry.title,
                ...(entry.subtitle === null ? {} : { subtitle: entry.subtitle }),
                target,
                backendTarget: entry.backendTarget,
                // The catalog already resolved the operational Agent for this
                // target. Carrying only the strict target would force every
                // consumer to re-derive it, and the one that did could not name
                // a plugin Agent at all.
                agentId: entry.agentId,
                // The same Agent-behavior owner New Session asks, for the same
                // Machine, under the same scoped feature decision.
                supportsDirectTranscriptStorage: directTranscriptsEnabled
                    && supportsDirectTranscriptStorageForNewSession({
                        agentId: entry.agentId,
                        machineId,
                        settings,
                    }),
                // The Agent's own Connected Account declarations, exactly as the
                // authoritative machine catalog projection resolved them. The
                // binding keys are the canonical qualified keys of these
                // declarations, never a bundled scalar enum.
                connectedAccounts: entry.agentCatalogEntry.connectedAccounts,
                ...(runtimeBackendModePresentation === null
                    ? {}
                    : {
                        runtimeBackendMode: {
                            title: runtimeBackendModePresentation.title,
                            options: runtimeBackendModeOptions,
                        },
                    }),
            });
        }
        return options;
    }, [backendEntries, directTranscriptsEnabled, localizePluginText, machineAgents, machineId, projectionInputs, settings]);

    /**
     * Which Agent New Session would preselect here, resolved by that same owner
     * and then required to be one of the options above.
     *
     * It is offered only once this Machine's projection has resolved: before
     * then the catalog cannot name a plugin Agent, so a "default" computed from
     * it would be the bundled fallback wearing the contextual answer's name.
     */
    const contextualDefaultAgentTarget = React.useMemo<AgentExecutionTargetV1 | null>(() => {
        if (projectionInputs === null || agentTargets.length === 0 || !acpCatalog || acpCatalog.stale || acpCatalog.catalog.status !== 'ready') return null;
        const preferred = resolvePreferredBackendTarget({
            lastUsedAgent,
            lastUsedBackendTarget,
            machineAgents,
            acpCatalogSnapshot: acpCatalog.catalog,
            backendEnabledByTargetKey,
            daemonMergedProjectionInputs: projectionInputs,
        });
        if (!preferred) return null;
        const preferredKey = resolveBackendTargetKeyV2(preferred);
        return agentTargets.find((option) => option.id === preferredKey)?.target ?? null;
    }, [
        acpCatalog,
        agentTargets,
        backendEnabledByTargetKey,
        lastUsedAgent,
        lastUsedBackendTarget,
        machineAgents,
        projectionInputs,
    ]);

    const { profiles: launchProfiles, loading: profilesLoading, unavailableReason: profilesUnavailableReason } = useAiLaunchProfilesWithReadState();
    const profiles = React.useMemo(() => {
        if (!useProfiles) return [];
        return launchProfiles.map((profile) => ({
            id: profile.id,
            label: getProfileDisplayName(profile),
            ...(profile.description === undefined ? {} : { subtitle: profile.description }),
        }));
    }, [launchProfiles, useProfiles]);

    const targetIsWindows = selectedMachine?.metadata?.platform === 'win32';
    const machineName = selectedMachine === null ? null : getMachineDisplayName(selectedMachine);
    const { state: machineCapabilities } = useDaemonScopedMachineCapabilitiesCache({
        machineId,
        serverId,
        enabled: machineId !== null,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });
    const machineCapabilitiesSnapshot = machineCapabilities.status === 'loaded'
        || machineCapabilities.status === 'loading'
        || machineCapabilities.status === 'error'
        ? machineCapabilities.snapshot
        : undefined;
    const windowsTerminalAvailable = resolveWindowsTerminalAvailable({
        targetIsWindows,
        response: machineCapabilitiesSnapshot?.response,
    });

    // An MCP selection is previewed for an Agent against one exact Machine and
    // folder; without both there is no truthful preview, so the field stays
    // explicitly unavailable rather than showing an unscoped list.
    const mcp = React.useMemo<SessionAuthoringMcpContext | undefined>(() => (
        machineId === null || directory.length === 0
            ? undefined
            : { machineId, machineName, directory, serverId }
    ), [directory, machineId, machineName, serverId]);

    /**
     * The Home a Connected Service binding is authored against. Only the Home
     * is a fact of the surface; the Team credential resources it offers are
     * observed by the control that actually mounts, so a host that never shows
     * the field opens no Team subscriptions.
     */
    const connectedServices = React.useMemo<SessionAuthoringConnectedServicesContext>(
        () => ({ serverId }),
        [serverId],
    );

    return React.useMemo<SessionAuthoringControlFacts>(() => ({
        agentTargets,
        agentPickerContext: { machineId, serverId, directory },
        contextualDefaultAgentTarget,
        profiles,
        profilesEnabled: useProfiles,
        profilesLoading,
        profilesUnavailableReason,
        machineName,
        targetIsWindows,
        windowsTerminalAvailable,
        connectedServices,
        ...(mcp === undefined ? {} : { mcp }),
    }), [agentTargets, connectedServices, contextualDefaultAgentTarget, directory, machineId, machineName, mcp, profiles, profilesLoading, profilesUnavailableReason, serverId, targetIsWindows, useProfiles, windowsTerminalAvailable]);
}
