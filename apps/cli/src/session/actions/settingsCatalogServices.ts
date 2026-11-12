import { buildBackendTargetKeyV2, convertBackendTargetRefV2ToV1, parseBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { isBackendTargetDisabledByAccountSettings, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import { decodeScmDiffSummaryModelOverride, encodeScmDiffSummaryModelOverride, type ScmDiffSummaryCatalogMutationServicesV1,
    type ScmDiffSummaryCatalogUnavailableTargetV1 } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { buildScmDiffSummaryModelProfiles } from '@happier-dev/protocol/actions/settings/scmDiffSummaryModels';
import { readSettings, type StoredCredentials } from '@/persistence';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { readAgentStructuredOutputCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { probeAgentModelsBestEffort } from './cliActionDeps/resolveAgentProbeInventoryDeps';
import { probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';
import { readAgentRoutingIdForContributionIdentity, indexAgentRoutingIdsByContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { refreshActiveAcpCatalog, readActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, isCustomAcpAgentContributionIdentityV1, listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveVoiceAgentCatalogSelectionV1, type VoiceAgentCatalogEntryV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import { listSelectableBundledAgentExecutionTargets } from '@happier-dev/agents/definitions';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getAgentStaticModels } from '@happier-dev/agents';
import { readProviderStateSharingRiskAgentIdsV1, type ProviderStateSharingAgentV1 } from '@happier-dev/protocol/actions/settings/providerStateSharingMutations';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { readAgentConnectedDefaultRoutes } from '@/session/services/agentConnectedDefaultRoutes';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SpawnFailureV1 } from '@happier-dev/protocol/machines/processes/spawnFailureV1';

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
        const definition = entry.richDefinition?.definition;
        if (!definition) return null;
        agents.push({ agentId: entry.id, capability: definition.capabilities.providerStateSharing });
    }
    return readProviderStateSharingRiskAgentIdsV1(agents);
}

/** Catalog declarations come from the actual current native projection, never a UI-only fallback. */
export function createCliVoiceSettingsBindingContext(): PortableVoiceSettingsBindingContextV1 {
    const current = readCurrentContributionRegistry();
    const voiceProviders = current.voiceProviders ?? [];
    const generation = pluginReloadController.getState().generation;
    const entries = new Map<string, VoiceSettingsRegistryEntry>(BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES.map(entry => [entry.providerId, entry]));
    const contributions = voiceProviders.map(contribution => {
        const providerId = buildQualifiedPluginContributionKey(contribution.identity);
        const declaration = contribution.definition;
        const providerSettings = declaration.settings ? createExternalVoiceProviderSettingsDescriptor(declaration.settings) : null;
        entries.set(providerId, Object.freeze({ providerId, pluginId: contribution.pluginId, declaration,
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
        voiceProviders.some(entry => entry.provenance === 'first_party' && entry.pluginId === contribution.pluginId)),
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
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    serverHttpBaseUrl?: string;
    authorizeConnectedAccountRequest?: Parameters<typeof readActiveConnectedAccountCatalog>[0]['authorizeRequest'];
    signal?: AbortSignal;
    serverId?: string;
    expectedAccountId?: string;
    voiceOwner?: VoiceSettingsOwner;
    readMachineAgentProjection?: (machineId: string, signal?: AbortSignal) => Promise<PluginProjectionV2 | null>;
}>): CliSettingsCatalogServicesV1 {
    let remoteProof: Readonly<{ machineId: string; generation: number }> | null = null;
    let sharingProof: Readonly<{ registry: ReturnType<typeof readCurrentContributionRegistry>; generation: number }> | null = null;
    const operationContext = params.savedSecretOperationContext;
    const readAccountSnapshot = () => operationContext ? operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    const accountIsCurrent = (lifetime: number) => operationContext ? readAccountSnapshot() !== null
        : getActiveAccountSettingsSnapshotLifetimeToken() === lifetime;
    const probeSummaryModels = (input: Parameters<typeof probeAgentModelsBestEffort>[0]) => runWithServerHttpBaseUrl(
        operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        () => probeAgentModelsBestEffort({ ...input, ...(operationContext ? { savedSecretOperationContext: operationContext } : {}) }));
    const readSelectedSummaryCatalog = async (settings: AccountSettings, storedValue: string, capturedAcpCatalog?: AcpCatalogSnapshotV1, bypassCache = false) => {
        const selector = decodeScmDiffSummaryModelOverride(storedValue);
        if (!selector?.backendTargetKey) return null;
        let executionTarget: ReturnType<typeof parseBackendTargetKeyV2>;
        try { executionTarget = parseBackendTargetKeyV2(selector.backendTargetKey); } catch { return null; }
        const registry = readCurrentContributionRegistry();
        const identity = executionTarget.kind === 'agent' ? executionTarget.identity : null;
        const parsedKey = identity
            ? [...registry.agentDefinitionsById.values()].find(entry => entry.identity
                && entry.identity.pluginId === identity.pluginId && entry.identity.localId === identity.localId)
            : executionTarget.kind === 'backend' ? registry.agentDefinitionsById.get(executionTarget.backendId) : undefined;
        const configured = executionTarget.kind === 'agent' && Boolean(executionTarget.definitionId);
        const agentId = parsedKey?.identity
            ? readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity([...registry.agentDefinitionsById.values()]), parsedKey.identity)
            : parsedKey?.id;
        if (!agentId) return null;
        const target: ReturnType<typeof readBackendTargetRefV2> = executionTarget.kind === 'backend' ? executionTarget
            : configured ? readBackendTargetRefV2(executionTarget) : { kind: 'backend', backendId: agentId, sourceKind: 'built_in' };
        if (isBackendTargetDisabledByAccountSettings(settings, target)) return null;
        const acpCatalog = configured ? capturedAcpCatalog ?? (params.credentials
            ? await refreshActiveAcpCatalog({ credentials: params.credentials, signal: params.signal, operationContext }) : undefined) : undefined;
        if (configured && acpCatalog?.status !== 'ready') return null;
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const probe = await probeSummaryModels({ agentId, cwd: sessionWorkingDirectory(), accountSettings: settings,
            catalogEntry: registry.catalogEntriesById[agentId], backendTarget: convertBackendTargetRefV2ToV1(target), bypassCache,
            ...(params.credentials ? { credentials: params.credentials } : {}),
            ...(acpCatalog ? { acpCatalogSnapshot: acpCatalog } : {}), ...(params.signal ? { signal: params.signal } : {}),
        });
        params.signal?.throwIfAborted();
        const profiles = probe.source === 'unavailable' ? [] : buildScmDiffSummaryModelProfiles({ backendTarget: executionTarget, models: probe.availableModels,
            catalogModels: getAgentStaticModels(agentId, { catalogOnly: true }),
            agentFormats: configured ? null : readAgentStructuredOutputCapabilities(parsedKey?.richDefinition?.definition)?.formats });
        return { profiles, ...(probe.spawnFailure ? { probeFailures: [{ backendTargetKey: selector.backendTargetKey, spawnFailure: probe.spawnFailure }] } : {}),
            isCurrent: (current: AccountSettings) => !params.signal?.aborted
            && readCurrentContributionRegistry() === registry
            && accountIsCurrent(lifetime)
            && (!acpCatalog || readAccountSnapshot()?.acpCatalog === acpCatalog)
            && JSON.stringify(current.backendEnabledByTargetKey) === JSON.stringify(settings.backendEnabledByTargetKey) };
    };
    const services: CliSettingsCatalogServicesV1 = {
        isCurrent: async () => {
            if (params.signal?.aborted) return false;
            if (operationContext && !await operationContext.isCurrent()) return false;
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
        readAgentCatalog: async (settings, selectedValue) => {
            const bundledEntries = listSelectableBundledAgentExecutionTargets().map(({ agentId, target }) => ({
                agentId, backendTargetKey: buildBackendTargetKeyV2(target), identity: target.identity,
                projectionGeneration: null, isBuiltIn: true,
                enabled: !isBackendTargetDisabledByAccountSettings(settings, target),
            }));
            if (selectedValue && resolveVoiceAgentCatalogSelectionV1(bundledEntries, selectedValue)) {
                return { entries: bundledEntries, isCurrent: latest => !params.signal?.aborted
                    && JSON.stringify(latest.backendEnabledByTargetKey) === JSON.stringify(settings.backendEnabledByTargetKey) };
            }
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
                if (!entry.identity) return [];
                const isBuiltIn = entry.isBuiltIn === true;
                return listAgentExecutionTargetsV1(entry.identity).map(target => {
                    const backendTargetKey = buildBackendTargetKeyV2(target);
                    return { agentId: entry.id, backendTargetKey, identity: target.identity,
                        projectionGeneration: isBuiltIn ? null : generation, isBuiltIn,
                        enabled: !isBackendTargetDisabledByAccountSettings(settings, backendTargetKey) };
                });
            }) : [...registry!.agentDefinitionsById.values()].flatMap(entry => {
                if (!entry.identity || !registry!.catalogEntriesById[entry.id]) return [];
                const isBuiltIn = entry.provenance === 'first_party';
                return listAgentExecutionTargetsV1(entry.identity).map(target => {
                    const backendTargetKey = buildBackendTargetKeyV2(target);
                    return { agentId: entry.id, backendTargetKey,
                        identity: target.identity, projectionGeneration: isBuiltIn ? null : generation, isBuiltIn,
                        enabled: !isBackendTargetDisabledByAccountSettings(settings, backendTargetKey),
                    };
                });
            });
            const configuredAgent = projection
                ? Object.values(projection.agentsById).find(entry => isCustomAcpAgentContributionIdentityV1(entry.identity))
                : [...registry!.agentDefinitionsById.values()].find(entry => isCustomAcpAgentContributionIdentityV1(entry.identity));
            const catalog = configuredAgent ? await refreshActiveAcpCatalog({ credentials: params.credentials, signal: params.signal }) : null;
            if (configuredAgent && catalog?.status !== 'ready') return null;
            if (configuredAgent && catalog?.status === 'ready') for (const definition of catalog.record.definitions) {
                for (const target of listAgentExecutionTargetsV1(CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, [definition.id])) {
                    entries.push({ agentId: configuredAgent.id, backendTargetKey: buildBackendTargetKeyV2(target),
                        identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, projectionGeneration: generation, isBuiltIn: false,
                        enabled: !isBackendTargetDisabledByAccountSettings(settings, target),
                    });
                }
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
        readScmDiffSummaryCatalog: async (settings, storedValue, options) => {
            params.signal?.throwIfAborted();
            if (options?.includeConfigured) {
                const automatic = await services.readScmDiffSummaryCatalog!(settings, '');
                if (!automatic) return null;
                const registry = readCurrentContributionRegistry();
                const configuredAgent = [...registry.agentDefinitionsById.values()].find(entry => isCustomAcpAgentContributionIdentityV1(entry.identity));
                const acpCatalog = configuredAgent && params.credentials
                    ? await refreshActiveAcpCatalog({ credentials: params.credentials, signal: params.signal, operationContext }) : undefined;
                const configuredTargets = acpCatalog?.status === 'ready'
                    ? acpCatalog.record.definitions.flatMap(definition => listAgentExecutionTargetsV1(CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, [definition.id]))
                        .filter(target => !isBackendTargetDisabledByAccountSettings(settings, target)).map(buildBackendTargetKeyV2) : [];
                const discoveryTargetKeys = [...new Set([...(automatic.discoveryTargetKeys ?? []), ...configuredTargets])];
                // Automatic authentication evidence ranks defaults; it does not
                // withdraw explicit models for connected or attached selections.
                // Authored model facts need no native launch. Dynamic evidence
                // still uses the selected/discovery probe below.
                const unavailableTargetKeys = new Set(automatic.unavailableTargets?.map(target => target.backendTargetKey));
                const explicitProfiles = [...registry.agentDefinitionsById.values()].flatMap(entry => entry.identity
                    ? listAgentExecutionTargetsV1(entry.identity).flatMap(target => unavailableTargetKeys.has(buildBackendTargetKeyV2(target))
                        ? buildScmDiffSummaryModelProfiles({ backendTarget: target,
                            models: getAgentStaticModels(entry.id, { catalogOnly: true }),
                            agentFormats: readAgentStructuredOutputCapabilities(entry.richDefinition?.definition)?.formats }) : []) : []);
                const requestedTargets = new Set(configuredTargets);
                // Automatic authentication ranks defaults, not explicit model discovery.
                // Agents without authored models still need their native catalog when
                // the Session supplies a connected binding instead of a native login.
                for (const entry of registry.agentDefinitionsById.values()) {
                    if (!entry.identity || getAgentStaticModels(entry.id, { catalogOnly: true }).length
                        || !readAgentStructuredOutputCapabilities(entry.richDefinition?.definition)?.formats.includes('json')) continue;
                    for (const target of listAgentExecutionTargetsV1(entry.identity)) {
                        const key = buildBackendTargetKeyV2(target);
                        if (unavailableTargetKeys.has(key) && discoveryTargetKeys.includes(key)) requestedTargets.add(key);
                    }
                }
                const selected = decodeScmDiffSummaryModelOverride(storedValue);
                if (selected?.backendTargetKey && discoveryTargetKeys.includes(selected.backendTargetKey)) requestedTargets.add(selected.backendTargetKey);
                if (options.discoveryTargetKey && discoveryTargetKeys.includes(options.discoveryTargetKey)) requestedTargets.add(options.discoveryTargetKey);
                const selectedCatalogs = await Promise.all([...requestedTargets].map(backendTargetKey => readSelectedSummaryCatalog(settings,
                    encodeScmDiffSummaryModelOverride({ backendTargetKey, modelId: selected?.backendTargetKey === backendTargetKey ? selected.modelId : 'default' }),
                    acpCatalog, backendTargetKey === options.discoveryTargetKey)));
                const profiles = [...new Map([...automatic.profiles, ...explicitProfiles, ...selectedCatalogs.flatMap(catalog => catalog?.profiles ?? [])]
                    .map(profile => [profile.catalogId, profile])).values()];
                const failuresByTarget = new Map((automatic.probeFailures ?? []).map(failure => [failure.backendTargetKey, failure]));
                [...requestedTargets].forEach((target, index) => {
                    const catalog = selectedCatalogs[index];
                    if (!catalog) return;
                    failuresByTarget.delete(target);
                    for (const failure of catalog.probeFailures ?? []) failuresByTarget.set(failure.backendTargetKey, failure);
                });
                const probeFailures = [...failuresByTarget.values()];
                return { profiles, automaticProfiles: automatic.profiles, discoveryTargetKeys, ...(probeFailures.length ? { probeFailures } : {}),
                    ...(automatic.unavailableReason ? { unavailableReason: automatic.unavailableReason } : {}),
                    ...(automatic.unavailableTargets?.length ? { unavailableTargets: automatic.unavailableTargets } : {}),
                    isCurrent: current => automatic.isCurrent(current) && readCurrentContributionRegistry() === registry
                        && (!acpCatalog || readAccountSnapshot()?.acpCatalog === acpCatalog)
                        && selectedCatalogs.every(catalog => !catalog || catalog.isCurrent(current)) };
            }
            if (!storedValue) {
                const registry = readCurrentContributionRegistry();
                const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
                const agents = [...registry.agentDefinitionsById.values()];
                const discoveryTargetKeys = new Set<string>();
                const unavailableTargets: ScmDiffSummaryCatalogUnavailableTargetV1[] = [];
                const probeFailures: Array<{ backendTargetKey: string; spawnFailure: SpawnFailureV1 }> = [];
                const routingIds = indexAgentRoutingIdsByContributionIdentity(agents);
                // The same connected-default read the Agent backend inventory uses for readiness.
                const { purposeCatalog, dispositions } = await readAgentConnectedDefaultRoutes({
                    credentials: params.credentials, settings, signal: params.signal, operationContext,
                    authorizeRequest: params.authorizeConnectedAccountRequest, agentIds: agents.map(entry => entry.id),
                });
                const profiles = (await Promise.all(agents.map(async entry => {
                    const targets = entry.identity ? listAgentExecutionTargetsV1(entry.identity)
                        .filter(target => !isBackendTargetDisabledByAccountSettings(settings, target)) : [];
                    const staticModels = getAgentStaticModels(entry.id, { catalogOnly: true });
                    if (targets.length === 0) return [];
                    const targetKeys = targets.map(buildBackendTargetKeyV2);
                    for (const key of targetKeys) discoveryTargetKeys.add(key);
                    const defaultAuth = dispositions.get(entry.id) ?? null;
                    const connected = defaultAuth?.kind === 'connected';
                    // Run admission consumes this same default-auth owner. A
                    // signed-out native CLI does not withdraw a connected route.
                    const signIn = connected || defaultAuth?.kind === 'unavailable' ? null : await probeAgentSignInStatus(entry.id);
                    params.signal?.throwIfAborted();
                    const unavailableReason: ScmDiffSummaryCatalogUnavailableTargetV1['reason'] | null = defaultAuth?.kind === 'unavailable'
                        ? defaultAuth.reason === 'connected_account_purpose_catalog_unavailable' ? 'account_metadata_unavailable' : 'connected_default_unavailable'
                        : !connected && signIn?.status !== 'signedIn'
                            ? signIn?.status === 'signedOut' ? 'native_sign_in_required' : 'native_auth_unavailable' : null;
                    if (unavailableReason) {
                        unavailableTargets.push(...targetKeys.map(backendTargetKey => ({ backendTargetKey, reason: unavailableReason })));
                        return [];
                    }
                    return (await Promise.all(targets.map(async executionTarget => {
                        const agentId = readAgentRoutingIdForContributionIdentity(routingIds, executionTarget.identity);
                        if (!agentId) return [];
                        const target = readBackendTargetRefV2({ kind: 'backend', backendId: agentId, sourceKind: 'built_in' });
                        if (isBackendTargetDisabledByAccountSettings(settings, target)) return [];
                        const observation = staticModels.length ? null : await probeSummaryModels({
                            agentId, cwd: sessionWorkingDirectory(), accountSettings: settings,
                            catalogEntry: registry.catalogEntriesById[agentId], backendTarget: convertBackendTargetRefV2ToV1(target),
                            ...(params.credentials ? { credentials: params.credentials } : {}), signal: params.signal,
                        });
                        if (observation?.spawnFailure) probeFailures.push({ backendTargetKey: buildBackendTargetKeyV2(executionTarget), spawnFailure: observation.spawnFailure });
                        const models = observation?.availableModels ?? staticModels;
                        return buildScmDiffSummaryModelProfiles({ backendTarget: executionTarget,
                            models,
                            agentFormats: readAgentStructuredOutputCapabilities(entry.richDefinition?.definition)?.formats });
                    }))).flat();
                }))).flat();
                return { profiles, discoveryTargetKeys: [...discoveryTargetKeys], ...(probeFailures.length ? { probeFailures } : {}),
                    ...(unavailableTargets.length ? { unavailableTargets } : {}),
                    ...(purposeCatalog && purposeCatalog.status !== 'ready' ? { unavailableReason: 'account_metadata_unavailable' as const } : {}),
                    isCurrent: current => !params.signal?.aborted
                    && readCurrentContributionRegistry() === registry
                    && accountIsCurrent(lifetime)
                    && (purposeCatalog?.status !== 'ready' || readAccountSnapshot()?.connectedPurposeCatalog === purposeCatalog)
                    && JSON.stringify(current.backendEnabledByTargetKey) === JSON.stringify(settings.backendEnabledByTargetKey) };
            }
            return readSelectedSummaryCatalog(settings, storedValue);
        },
    };
    return services;
}
