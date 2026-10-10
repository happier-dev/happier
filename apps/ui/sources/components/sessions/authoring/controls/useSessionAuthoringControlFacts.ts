import * as React from 'react';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';

import type { AgentExecutionTargetV1 } from '@happier-dev/protocol';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { stripBackendTargetSourceKind } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { resolveAgentScopedPluginSettingPresentation } from '@/agents/registry/agentScopedPluginSettingsDeclarations';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { supportsDirectTranscriptStorageForNewSession } from '@/components/sessions/new/modules/newSessionTranscriptStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { useAllMachines, useSetting, useSettings } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
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
    const machines = useAllMachines();
    const settings = useSettings();
    const preferredLanguage = getPreferredLanguage();
    const { snapshot: acpCatalog } = useAcpCatalogForServer(params.serverId);
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const lastUsedAgent = useSetting('lastUsedAgent');
    const lastUsedBackendTarget = useSetting('lastUsedBackendTarget');
    const useProfiles = useSetting('useProfiles') === true;
    // The same scoped feature decisions New Session consults for this spawn target.
    const spawnFeatureScope = React.useMemo(
        () => (serverId === null ? undefined : { scopeKind: 'spawn' as const, serverId }),
        [serverId],
    );
    const directTranscriptsEnabled = useFeatureEnabled('sessions.direct', spawnFeatureScope);
    const mcpServersEnabled = useFeatureEnabled('mcp.servers', spawnFeatureScope);

    const daemonProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId,
        enabled: machineId !== null,
    });
    const projectionInputs = daemonProjection.phase === 'ready' ? daemonProjection.inputs : null;
    const pluginUiProjection = React.useMemo(
        () => projectionInputs?.pluginProjectionV2
            ? normalizePluginUiProjection(projectionInputs.pluginProjectionV2)
            : null,
        [projectionInputs?.pluginProjectionV2],
    );

    const agentTargets = React.useMemo<readonly SessionAuthoringAgentTargetOption[]>(() => {
        const entries = getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
            acpCatalogSnapshot: acpCatalog?.catalog,
            backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: projectionInputs?.mergedBackendProjectionById ?? null,
            ...(projectionInputs?.discoveredBackendIds === undefined
                ? {}
                : { discoveredBackendIds: projectionInputs.discoveredBackendIds }),
        });
        const options: SessionAuthoringAgentTargetOption[] = [];
        for (const entry of entries) {
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
                    localize: (pluginId, value) => resolvePluginLocalizedText({
                        projection: pluginUiProjection,
                        pluginId,
                        value,
                        locale: preferredLanguage,
                    }),
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
            options.push({
                pickerEntry: entry,
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
    }, [acpCatalog, backendEnabledByTargetKey, directTranscriptsEnabled, machineId, pluginUiProjection, preferredLanguage, projectionInputs, settings]);

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
        const preferred = resolvePreferredBackendTargetFromProjection({
            lastUsedAgent,
            lastUsedBackendTarget,
            acpCatalogSnapshot: acpCatalog.catalog,
            backendEnabledByTargetKey,
            daemonMergedProjectionInputs: projectionInputs,
        });
        const preferredKey = resolveBackendTargetKeyV2(preferred);
        return agentTargets.find((option) => option.id === preferredKey)?.target ?? null;
    }, [
        acpCatalog,
        agentTargets,
        backendEnabledByTargetKey,
        lastUsedAgent,
        lastUsedBackendTarget,
        projectionInputs,
    ]);

    const launchProfiles = useAiLaunchProfilesForLegacyUi();
    const profiles = React.useMemo(() => {
        if (!useProfiles) return [];
        return launchProfiles.map((profile) => ({
            id: profile.id,
            label: getProfileDisplayName(profile),
            ...(profile.description === undefined ? {} : { subtitle: profile.description }),
        }));
    }, [launchProfiles, useProfiles]);

    const selectedMachine = React.useMemo(
        () => (machineId === null ? null : machines.find((machine) => machine.id === machineId) ?? null),
        [machineId, machines],
    );
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
            : { machineId, machineName, directory, serverId, enabled: mcpServersEnabled }
    ), [directory, machineId, machineName, mcpServersEnabled, serverId]);

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
        machineName,
        targetIsWindows,
        windowsTerminalAvailable,
        connectedServices,
        ...(mcp === undefined ? {} : { mcp }),
    }), [agentTargets, connectedServices, contextualDefaultAgentTarget, directory, machineId, machineName, mcp, profiles, serverId, targetIsWindows, windowsTerminalAvailable]);
}
