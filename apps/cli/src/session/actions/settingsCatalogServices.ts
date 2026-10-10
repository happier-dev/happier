import { buildBackendTargetKeyV2, convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isBackendTargetDisabledByAccountSettings, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { decodeScmDiffSummaryModelOverride, type ScmDiffSummaryCatalogMutationServicesV1 } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { buildScmDiffSummaryModelProfiles } from '@happier-dev/protocol/actions/settings/scmDiffSummaryModels';
import { readSettings, type StoredCredentials } from '@/persistence';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { readAgentRoutingIdForContributionIdentity, indexAgentRoutingIdsByContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { refreshActiveAcpCatalog, readActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createVoiceSettingsOwner, type VoiceSettingsOwner } from '@happier-dev/protocol/voice/settings/voiceSettings';
import { createExternalVoiceProviderSettingsDescriptor } from '@happier-dev/protocol/voice/settings/externalProviderSettings';
import { createExternalVoiceProviderSettingsOwner } from '@happier-dev/protocol/voice/settings/providerSettings';
import { BUNDLED_FIRST_PARTY_VOICE_SELECTION_OPTIONS } from '@happier-dev/protocol/voice/settings/generatedBundledVoiceSelectionOptions';
import { BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES } from '@happier-dev/protocol/voice/settings/builtInRegistry';
import { projectVoiceProviderDeclarationRegistryBase, type VoiceSettingsRegistryEntry } from '@happier-dev/protocol/voice/settings/providerRegistry';
import type { PortableVoiceSettingsBindingContextV1 } from '@happier-dev/protocol/actions/settings/catalogAccountSettingBindings';
import type { VoiceSettingsMutationServicesV1 } from '@happier-dev/protocol/voice/settings/voiceSettingBindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, isCustomAcpAgentContributionIdentityV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { VoiceAgentCatalogEntryV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getAgentCore, isBundledAgentId } from '@happier-dev/agents';
import { readProviderStateSharingRiskAgentIdsV1, type ProviderStateSharingAgentV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';

export type CliSettingsCatalogServicesV1 = ScmDiffSummaryCatalogMutationServicesV1<AccountSettings>
    & VoiceSettingsMutationServicesV1<AccountSettings> & Readonly<{
        isCurrent(): Promise<boolean>;
        readProviderStateSharingRiskAgentIds(): readonly string[] | null;
    }>;

/** Native publication/activation facts distinguish no Agents from no authoritative catalog. */
export function projectCliProviderStateSharingRiskAgentIdsV1(
    registry: Pick<ReturnType<typeof readCurrentContributionRegistry>, 'agentDefinitionsById'>,
    readiness: Readonly<{ activated: boolean; unavailable: boolean }>,
): readonly string[] | null {
    if (readiness.unavailable || registry.agentDefinitionsById.size === 0 && !readiness.activated) return null;
    const agents: ProviderStateSharingAgentV1[] = [];
    for (const entry of registry.agentDefinitionsById.values()) {
        if (entry.provenance !== 'first_party' || !isBundledAgentId(entry.id)) return null;
        agents.push({ agentId: entry.id, capability: getAgentCore(entry.id).connectedServices?.providerStateSharing });
    }
    return readProviderStateSharingRiskAgentIdsV1(agents);
}

/** Catalog declarations come from the actual current native projection, never a UI-only fallback. */
export function createCliVoiceSettingsBindingContext(): PortableVoiceSettingsBindingContextV1 {
    const current = readCurrentContributionRegistry();
    const generation = pluginReloadController.getState().generation;
    const entries = new Map<string, VoiceSettingsRegistryEntry>(BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES.map(entry => [entry.providerId, entry]));
    const contributions = current.voiceProviders.map(contribution => {
        const providerId = buildQualifiedPluginContributionKey(contribution.identity);
        const declaration = contribution.definition;
        const providerSettings = declaration.settings ? createExternalVoiceProviderSettingsDescriptor(declaration.settings) : null;
        entries.set(providerId, Object.freeze({ providerId,
            kind: declaration.kind === 'conversation' ? 'voice.conversation-provider.v1' : 'voice.speech-engine.v1',
            ...projectVoiceProviderDeclarationRegistryBase({ declaration, providerSettings,
                ...(contribution.provenance === 'first_party' ? { selectionOptions: BUNDLED_FIRST_PARTY_VOICE_SELECTION_OPTIONS[providerId] } : {}),
            }),
        }));
        return { pluginId: contribution.pluginId, providerId, declaration };
    });
    const registry = {
        get: (providerId: string) => BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES.find(entry => entry.providerId === providerId)
            ?? (readCurrentContributionRegistry() === current ? entries.get(providerId) ?? null : null),
        list: () => readCurrentContributionRegistry() === current ? [...entries.values()] : BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES,
    };
    const owner = createVoiceSettingsOwner({ bundledContributions: contributions.filter(contribution =>
        current.voiceProviders.some(entry => entry.provenance === 'first_party' && entry.pluginId === contribution.pluginId)),
        resolveExternalProviderSettingsOwner: providerId => createExternalVoiceProviderSettingsOwner(providerId, registry.get(providerId)?.providerSettings),
    });
    return { owner, registry, isCurrent: () => readCurrentContributionRegistry() === current && pluginReloadController.getState().generation === generation,
        captureLanguageOwner: providerId => {
        const selected = registry.get(providerId ?? '');
        const builtIn = BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES.some(entry => entry === selected);
        return voice => voice.providerId === providerId && selected !== null && (builtIn || readCurrentContributionRegistry() === current);
    } };
}

/** Native model evidence comes from the same current Agent catalog and probe as Action inventory. */
export function createCliSettingsCatalogServices(params: Readonly<{
    credentials?: StoredCredentials;
    signal?: AbortSignal;
    serverId?: string;
    expectedAccountId?: string;
    voiceOwner?: VoiceSettingsOwner;
    readMachineAgentProjection?: (machineId: string, signal?: AbortSignal) => Promise<PluginProjectionV2 | null>;
}>): CliSettingsCatalogServicesV1 {
    let remoteProof: Readonly<{ machineId: string; generation: number }> | null = null;
    let sharingProof: Readonly<{ registry: ReturnType<typeof readCurrentContributionRegistry>; generation: number }> | null = null;
    return {
        isCurrent: async () => {
            if (params.signal?.aborted) return false;
            if (sharingProof) {
                const state = pluginReloadController.getState();
                if (readCurrentContributionRegistry() !== sharingProof.registry || state.generation !== sharingProof.generation
                    || (state.activeRegistry ? !pluginReloadController.isRuntimeRegistryCurrent(state.activeRegistry)
                        : state.lastResult?.ok === false)) return false;
            }
            const proof = remoteProof;
            if (!proof) return true;
            const latest = await params.readMachineAgentProjection?.(proof.machineId, params.signal);
            return !params.signal?.aborted && latest?.generation === proof.generation;
        },
        readProviderStateSharingRiskAgentIds: () => {
            const registry = readCurrentContributionRegistry();
            const state = pluginReloadController.getState();
            const generation = state.generation;
            if (params.signal?.aborted || sharingProof && (sharingProof.registry !== registry || sharingProof.generation !== generation)) return null;
            // The cold snapshot has no activated-empty proof; a failed/stale runtime is not an empty risk catalog.
            const activated = state.activeRegistry && pluginReloadController.isRuntimeRegistryCurrent(state.activeRegistry)
                && state.activeRegistry.contributes === registry;
            sharingProof ??= { registry, generation };
            return projectCliProviderStateSharingRiskAgentIdsV1(registry, { activated: Boolean(activated),
                unavailable: state.activeRegistry ? !activated : state.lastResult?.ok === false });
        },
        readAgentCatalog: async settings => {
            // Automatic Voice selection is UI-local (sticky/preferred computer), not this process.
            // Fixed computers use exact machine evidence; native fallback is admitted only for this computer.
            const voice = params.voiceOwner?.voiceSettingsParse(settings.voice);
            if (!voice || voice.executionMachine.mode !== 'fixed' || !voice.executionMachine.machineId
                || !params.serverId || !params.expectedAccountId || !params.credentials) return null;
            const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            const projection = params.readMachineAgentProjection
                ? await params.readMachineAgentProjection(voice.executionMachine.machineId, params.signal) : null;
            if (params.readMachineAgentProjection && !projection) return null;
            const registry = projection ? null : readCurrentContributionRegistry();
            if (registry) {
                const local = await readSettings();
                if (resolveMachineIdForServerFromSettings(local, params.serverId, params.expectedAccountId) !== voice.executionMachine.machineId) return null;
            }
            const generation = projection?.generation ?? pluginReloadController.getState().generation;
            const entries: VoiceAgentCatalogEntryV1[] = projection ? Object.values(projection.agentsById).flatMap(entry => {
                if (!entry.identity || isCustomAcpAgentContributionIdentityV1(entry.identity)) return [];
                const backendTargetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: entry.identity });
                const isBuiltIn = entry.isBuiltIn === true;
                return [{ agentId: entry.id, backendTargetKey, identity: entry.identity,
                    projectionGeneration: isBuiltIn ? null : generation, isBuiltIn,
                    enabled: !isBackendTargetDisabledByAccountSettings(settings, backendTargetKey) }];
            }) : [...registry!.agentDefinitionsById.values()].flatMap(entry => {
                if (!entry.identity || isCustomAcpAgentContributionIdentityV1(entry.identity) || !registry!.catalogEntriesById[entry.id]) return [];
                const isBuiltIn = entry.provenance === 'first_party';
                const backendTargetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: entry.identity });
                return [{ agentId: entry.id, backendTargetKey,
                    identity: entry.identity, projectionGeneration: isBuiltIn ? null : generation, isBuiltIn,
                    enabled: !isBackendTargetDisabledByAccountSettings(settings, backendTargetKey),
                }];
            });
            const configuredAgent = projection
                ? Object.values(projection.agentsById).find(entry => isCustomAcpAgentContributionIdentityV1(entry.identity))
                : [...registry!.agentDefinitionsById.values()].find(entry => isCustomAcpAgentContributionIdentityV1(entry.identity));
            const catalog = configuredAgent ? await refreshActiveAcpCatalog({ credentials: params.credentials, signal: params.signal }) : null;
            if (configuredAgent && catalog?.status !== 'ready') return null;
            if (configuredAgent && catalog?.status === 'ready') for (const definition of catalog.record.definitions) {
                const target = { kind: 'backend' as const, backendId: definition.id, configuredBackendId: definition.id, sourceKind: 'configured' as const };
                entries.push({ agentId: configuredAgent.id, backendTargetKey: buildBackendTargetKeyV2(target),
                    identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, projectionGeneration: generation, isBuiltIn: false,
                    enabled: !isBackendTargetDisabledByAccountSettings(settings, target),
                });
            }
            if (projection) remoteProof = { machineId: voice.executionMachine.machineId, generation };
            return { entries, isCurrent: latest => !params.signal?.aborted
                && (!registry || readCurrentContributionRegistry() === registry && pluginReloadController.getState().generation === generation)
                && getActiveAccountSettingsSnapshotLifetimeToken() === lifetime && (!catalog || readActiveAcpCatalog() === catalog)
                && params.voiceOwner?.voiceSettingsParse(latest.voice).providerId === voice.providerId
                && JSON.stringify(params.voiceOwner?.voiceSettingsParse(latest.voice).executionMachine) === JSON.stringify(voice.executionMachine)
                && JSON.stringify(latest.backendEnabledByTargetKey) === JSON.stringify(settings.backendEnabledByTargetKey),
            };
        },
        readScmDiffSummaryCatalog: async (settings, storedValue) => {
            params.signal?.throwIfAborted();
            const selector = decodeScmDiffSummaryModelOverride(storedValue);
            if (!selector?.backendTargetKey) return null;
            let target: ReturnType<typeof readBackendTargetRefV2>;
            try { target = readBackendTargetRefV2(selector.backendTargetKey); } catch { return null; }
            if (isBackendTargetDisabledByAccountSettings(settings, target)) return null;
            const registry = readCurrentContributionRegistry();
            const parsedKey = selector.backendTargetKey.startsWith('agent:')
                ? [...registry.agentDefinitionsById.values()].find(entry => entry.identity
                    && buildBackendTargetKeyV2({ kind: 'agent', identity: entry.identity }) === selector.backendTargetKey)
                : registry.agentDefinitionsById.get(target.backendId);
            const configured = target.sourceKind === 'configured' || Boolean(target.configuredBackendId);
            const configuredAgent = configured ? [...registry.agentDefinitionsById.values()].find(entry => isCustomAcpAgentContributionIdentityV1(entry.identity)) : undefined;
            const agentId = configured ? configuredAgent?.id : parsedKey?.identity
                ? readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity([...registry.agentDefinitionsById.values()]), parsedKey.identity)
                : parsedKey?.id;
            if (!agentId) return null;
            const acpCatalog = configured && params.credentials
                ? await refreshActiveAcpCatalog({ credentials: params.credentials, signal: params.signal }) : undefined;
            if (configured && acpCatalog?.status !== 'ready') return null;
            const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            const probe = await probeAgentModelsBestEffort({ agentId, cwd: process.cwd(), accountSettings: settings,
                catalogEntry: registry.catalogEntriesById[agentId], backendTarget: convertBackendTargetRefV2ToV1(target),
                ...(params.credentials ? { credentials: params.credentials } : {}),
                ...(acpCatalog ? { acpCatalogSnapshot: acpCatalog } : {}), ...(params.signal ? { signal: params.signal } : {}),
            });
            params.signal?.throwIfAborted();
            if (probe.source === 'unavailable') return null;
            const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: target, models: probe.availableModels,
                agentFormats: configured ? null : readAgentStructuredOutputCapabilities(parsedKey?.richDefinition?.definition)?.formats });
            return { profiles, isCurrent: current => !params.signal?.aborted
                && readCurrentContributionRegistry() === registry
                && getActiveAccountSettingsSnapshotLifetimeToken() === lifetime
                && (!acpCatalog || readActiveAcpCatalog() === acpCatalog)
                && JSON.stringify(current.backendEnabledByTargetKey) === JSON.stringify(settings.backendEnabledByTargetKey) };
        },
    };
}
