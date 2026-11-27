import { readMachineAgentsForScope, refreshMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { getVoiceSessionActiveAgentRuntime } from '@/voice/session/voiceSessionStore';
import { EMPTY_MACHINE_AGENTS } from '@/agents/machineAgents/machineAgentInventoryStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';
import { type projectVoiceSelectedAgentReadiness } from '@/voice/agent/projectVoiceAgentSelection';
import type { ConnectedServiceBindingsV1} from '@happier-dev/protocol/connect/connected-service-bindings';
import type { DaemonVoiceInferenceModelStatus} from '@happier-dev/protocol/daemon/voiceInference';
import type { PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type { VoiceRawCredentialGrantDeclaration } from '@happier-dev/protocol/plugins/contributions/voice';
import { VoiceRuntimePlatformSchema } from '@happier-dev/protocol/voice/realtime/capabilities';
import { getDefaultModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { Platform } from 'react-native';
import type { SettingOperationContext } from '@/components/settings/catalog/settingDeclarations';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { resolveAccountVoiceCredentialSourceSelection, resolveSelectedVoiceCredentialRawGrants } from '@/voice/credentials/accountVoiceCredential';
import { inspectRawCredentialAuthorizationReadiness } from '@/voice/credentials/rawCredentialAuthorizationClient';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings, resolveLocalVoiceAdapterSettingsFromVoice } from '@/voice/local/localVoiceSettings';
import { projectVoiceProviderSettings, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectVoiceProviderAgentRealtimePassiveSetup, readVoiceProviderConnectedServicesBinding, readVoiceProviderPassiveRealtimeSetupResult, type VoiceProviderAgentRealtimePassiveSetup } from './passiveSetup';
import { createVoiceDictationRuntimeSettingsSnapshot } from '@/voice/dictation/voiceDictationRuntimeSettings';
import { readVoiceDictationNativeModelReadiness } from '@/voice/dictation/voiceDictationNativeModelReadiness';
import { resolveVoiceDictationNativeLocalNeuralModelSelection, resolveVoiceDictationReadiness } from '@/voice/dictation/voiceDictationReadiness';
import { storage } from '@/sync/domains/state/storage';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { loadDaemonMergedProjectionInputs, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { PROVIDER_DECLARATION_CONTEXT_SECTIONS, providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { loadHomeTeamCredentialModelCatalog } from '@/hooks/teams/homeTeamCredentialModelCatalog';
import { describeProviderModels } from '@/providers/actions/client';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { resolveVoiceConfiguredAgentTarget } from '@/voice/agent/resolveVoiceConfiguredAgentTarget';
import { resolveVoiceConnectedAccountTargetEligibility } from '@/voice/credentials/sourceEligibility';
import { readDeviceSpeechRecognitionAvailability } from '@/voice/input/deviceSpeechRecognitionAvailability';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { resolveDaemonSpeechPcmCaptureAvailability } from '@/voice/runtime/daemonInference/resolveDaemonSpeechPcmCaptureAvailability';
import { readPassiveBrowserWebSpeechCapability } from './browserWebSpeechCapability';
import { resolveVoiceProviderAvailability } from './resolveVoiceProviderAvailability';
import { projectVoiceConversationAgentSelection, projectVoiceConversationReadiness } from './projectVoiceConversationReadiness';
import { resolveVoiceDaemonDirectRouteAvailability, resolveVoiceDaemonModelAvailabilityFromCatalogState, resolveVoiceDaemonModelKindAvailabilityFromCatalogState, resolveVoiceProviderLocalAvailability } from './voiceProviderLocalAvailability';
import type { VoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { captureDaemonVoiceModelCatalogObservation, readDaemonVoiceModelCatalogErrorCode } from './panels/modelCatalog/daemonVoiceModelCatalogObservation';

export type VoiceRawSpeechReadinessTarget = Readonly<{
    providerId: string;
    contribution: PluginContributionIdentityV1;
    rawGrants: readonly VoiceRawCredentialGrantDeclaration[];
}>;

/** Canonical selected speech credential targets, shared by page checks and Actions. */
export function projectVoiceRawSpeechReadinessTargets(settings: Pick<Settings, 'voice' | 'voiceSettingsV1' | 'secrets'>, registry: VoiceProviderRegistry, machineId: string | null, purpose: 'conversation' | 'dictation', connectedPurposes: ConnectedPurposeCatalogV1 | null): readonly VoiceRawSpeechReadinessTarget[] | null {
    const runtime = purpose === 'dictation' ? createVoiceDictationRuntimeSettingsSnapshot(settings) : settings;
    const config = purpose === 'conversation'
        ? resolveLocalVoiceAdapterSettingsFromVoice(settings.voice).config
        : resolveLocalVoiceAdapterSettings(runtime).config;
    const providerIds = purpose === 'dictation' ? [parseLocalVoiceSttSettings(config.stt).provider]
        : [parseLocalVoiceSttSettings(config.stt).provider, parseLocalVoiceTtsSettings(config.tts).provider];
    const targets: VoiceRawSpeechReadinessTarget[] = [];
    for (const providerId of new Set(providerIds)) {
        const entry = registry.get(providerId);
        if (entry?.kind !== 'voice.speech-engine.v1' || entry.declaration?.kind !== 'speech' || !entry.declaration.credentials) continue;
        const contribution = { pluginId: entry.pluginId, localId: entry.declaration.id };
        try {
            const source = resolveAccountVoiceCredentialSourceSelection({ settings, connectedPurposes, contribution,
                credentialSlotId: entry.declaration.credentials.slot.id,
                purpose: { consumer: contribution, purpose: entry.declaration.credentials.slot.purpose }, machineId });
            const rawGrants = resolveSelectedVoiceCredentialRawGrants({ declaration: entry.declaration, contribution,
                selection: source.selection, access: { realm: 'daemon', phase: 'speech' } });
            if (rawGrants.length) targets.push({ providerId, contribution, rawGrants });
        } catch { return null; }
    }
    return targets;
}

export async function inspectVoiceDictationSettingsReadiness(input: Readonly<{
    packId: string | null;
    rawTarget: Pick<VoiceRawSpeechReadinessTarget, 'contribution' | 'rawGrants'> | null;
    signal?: AbortSignal;
}>) {
    const rawTarget = input.rawTarget;
    const [nativeLocalNeuralModel, rawCredentialAuthorization] = await Promise.all([
        input.packId ? readVoiceDictationNativeModelReadiness(input.packId) : Promise.resolve(null),
        rawTarget ? Promise.all(rawTarget.rawGrants.map(grant => inspectRawCredentialAuthorizationReadiness(rawTarget.contribution, grant, input.signal)))
            .then(values => values.some(value => value === 'unknown') ? 'unknown' as const : values.some(value => value === 'approval_required') ? 'approval_required' as const : 'ready' as const)
            : Promise.resolve(null),
    ]);
    return { nativeLocalNeuralModel, rawCredentialAuthorization };
}

/** Passive probes never open a provider or microphone and never grant credential access. */
export async function inspectVoiceProviderReadiness(input: Readonly<{
    machineId: string | null;
    passiveSetup: VoiceProviderAgentRealtimePassiveSetup | null;
    connectedServices: ConnectedServiceBindingsV1 | null;
    rawTargets: readonly VoiceRawSpeechReadinessTarget[] | null;
    signal?: AbortSignal;
    isCurrent(): boolean;
}>) {
    const passiveResult = input.machineId && input.passiveSetup && input.connectedServices && input.isCurrent()
        ? machineCapabilitiesInvoke(input.machineId, { id: input.passiveSetup.capabilityId, method: 'probePassiveRealtimeSetup',
            params: { connectedServices: input.connectedServices } }, { timeoutMs: 30_000, signal: input.signal }).then(outcome =>
                outcome.supported && outcome.response.ok ? readVoiceProviderPassiveRealtimeSetupResult(outcome.response.result) : null, () => null)
        : Promise.resolve(null);
    const rawResult = input.rawTargets === null ? Promise.resolve(null) : Promise.all(input.rawTargets.map(async target => {
        const statuses = await Promise.all(target.rawGrants.map(grant => input.isCurrent()
            ? inspectRawCredentialAuthorizationReadiness(target.contribution, grant, input.signal)
            : Promise.resolve('unknown' as const)));
        const status = statuses.some(value => value === 'unknown') ? 'unknown' as const
            : statuses.some(value => value === 'approval_required') ? 'approval_required' as const : 'ready' as const;
        return { providerId: target.providerId, contribution: target.contribution, status };
    }));
    const [passive, raw] = await Promise.all([passiveResult, rawResult]);
    return { passive, raw };
}

/** Settings Actions read the same established facts and role projectors as page/setup. */
export async function inspectVoiceSettingsSemanticReadiness(input: Readonly<{
    settings: Settings;
    purpose: 'conversation' | 'dictation';
    machine: VoiceExecutionMachinePresentation;
    context: SettingOperationContext;
    isCurrent(): boolean;
}>) {
    const { settings, purpose, machine, context } = input;
    const voice = settings.voice;
    const registry = createDefaultVoiceProviderRegistry();
    const parsedPlatform = VoiceRuntimePlatformSchema.safeParse(Platform.OS);
    const platform = parsedPlatform.success ? parsedPlatform.data : 'unknown';
    const runtimeSettings = purpose === 'dictation' ? createVoiceDictationRuntimeSettingsSnapshot(settings) : settings;
    const localAdapter = resolveLocalVoiceAdapterSettings(runtimeSettings);
    const localConfig = localAdapter.config;
    const stt = parseLocalVoiceSttSettings(localConfig.stt);
    const tts = parseLocalVoiceTtsSettings(localConfig.tts);
    const localSelected = voice.providerId === 'local_conversation' || voice.providerId === 'local_direct';
    const requireStt = (purpose === 'dictation' || localSelected) && stt.provider === 'local_neural'
        && resolveLocalNeuralExecutionPolicy({ requestedExecution: stt.localNeural.execution, platformOs: platform }).preferredExecution === 'daemon';
    const requireTts = purpose === 'conversation' && localSelected && tts.provider === 'local_neural'
        && resolveLocalNeuralExecutionPolicy({ requestedExecution: tts.localNeural.execution, platformOs: platform }).preferredExecution === 'daemon';
    const [hostedEnabled, daemonFeatureEnabled, accountGroupsEnabled] = await Promise.all([
        context.isFeatureEnabled?.('voice.happierVoice') ?? false,
        context.isFeatureEnabled?.('voice.daemonInference') ?? false, context.isFeatureEnabled?.('connectedServices.accountGroups') ?? false,
    ]);
    const state = storage.getState();
    const scope = state.settingsScope;
    const appliedServer = getAppliedActiveServerSnapshot();
    const serverId = scope?.serverId ?? appliedServer.serverId;
    const featureSnapshot = getCachedServerFeaturesSnapshot({ serverId });
    const serverFeatures = featureSnapshot?.status === 'ready' ? featureSnapshot.features : null;
    const voiceAgentAvailability = resolveFeatureAvailabilityArm(resolveRuntimeFeatureDecisionFromSnapshot({
        featureId: 'voice.agent', settings, snapshot: featureSnapshot ?? { status: 'loading' },
    }));
    const daemonFeatureAvailability = resolveFeatureAvailabilityArm(resolveRuntimeFeatureDecisionFromSnapshot({
        featureId: 'voice.daemonInference', settings, snapshot: featureSnapshot ?? { status: 'loading' },
    }));
    const [{ models, modelError }, credentials, nativeDeviceSpeechRecognition, inspectedConnectedPurposes] = await Promise.all([
        (async () => {
            let models: readonly DaemonVoiceInferenceModelStatus[] = [];
            let modelError: Parameters<typeof resolveVoiceDaemonModelAvailabilityFromCatalogState>[0]['errorCode'] = null;
            if ((requireStt || requireTts) && machine.machineId && daemonFeatureEnabled && input.isCurrent()) {
                try {
                    const packIds = [requireStt ? stt.localNeural.assetId ?? getDefaultModelPackId('stt_sherpa') : null,
                        requireTts ? tts.localNeural.assetId ?? getDefaultModelPackId('tts_sherpa') : null]
                        .filter((id): id is string => Boolean(id));
                    models = await captureDaemonVoiceModelCatalogObservation(machine.machineId).read({
                        client: new DaemonVoiceInferenceClient(), packIds, requireNewObservation: true, isCurrent: input.isCurrent, signal: context.signal,
                    }) ?? [];
                } catch (error) {
                    modelError = readDaemonVoiceModelCatalogErrorCode(error);
                }
            }
            return { models, modelError };
        })(),
        (requireStt || requireTts) && machine.machineId && input.isCurrent()
            ? TokenStorage.getCredentialsForServerUrl(appliedServer.serverUrl, { serverId: appliedServer.serverId }) : null,
        platform === 'web' || stt.provider !== 'device' ? 'unknown' as const
            : import('expo-speech-recognition').then(({ ExpoSpeechRecognitionModule }) => readDeviceSpeechRecognitionAvailability(ExpoSpeechRecognitionModule), () => 'unknown' as const),
        context.services?.readConnectedAccountPurposes?.(context.signal),
    ]);
    const modelAvailability = resolveVoiceDaemonModelAvailabilityFromCatalogState({ loading: false, errorCode: modelError,
        statuses: models, selectedSttPackId: stt.localNeural.assetId, selectedTtsPackId: tts.localNeural.assetId, requireStt, requireTts });
    const selectedMachine = machine.machineId ? resolveMachineForActiveServerFromState(state, machine.machineId, { serverId }) : null;
    const localAvailability = resolveVoiceProviderLocalAvailability({ serverFeatures, daemonFeatureEnabled,
        daemonFeatureAvailability, platformOs: platform,
        browserSpeechCapability: readPassiveBrowserWebSpeechCapability({ platformOs: platform }), nativeDeviceSpeechRecognition,
        daemonModelState: modelAvailability.modelState, daemonRuntimeState: modelAvailability.runtimeState,
        daemonSpeech: {
            stt: resolveVoiceDaemonModelKindAvailabilityFromCatalogState({ loading: false, errorCode: modelError,
                statuses: models, kind: 'stt_sherpa', selectedPackId: stt.localNeural.assetId }),
            tts: resolveVoiceDaemonModelKindAvailabilityFromCatalogState({ loading: false, errorCode: modelError,
                statuses: models, kind: 'tts_sherpa', selectedPackId: tts.localNeural.assetId }),
        },
        daemonPcmCapture: resolveDaemonSpeechPcmCaptureAvailability(), daemonDirectRouteAvailability: resolveVoiceDaemonDirectRouteAvailability({
            serverFeatures, credentials, endpoint: selectedMachine?.daemonState?.peerMediation?.loopback?.endpoint ?? null }) });
    const purposeSnapshot = getConnectedAccountCatalogValue(scope, 'purposes');
    const connectedPurposes = inspectedConnectedPurposes === undefined
        ? purposeSnapshot.status === 'ready' && !purposeSnapshot.stale ? purposeSnapshot.value : null
        : inspectedConnectedPurposes;
    const resolveSavedSecret = (ref: string) => resolveSavedSecretReference(scope, settings.secrets, ref);
    const rawTargets = purpose === 'dictation' || localSelected
        ? projectVoiceRawSpeechReadinessTargets(settings, registry, machine.machineId, purpose, connectedPurposes) : [];
    // A selected speech credential that cannot be resolved without the connected-purpose catalog is not "ready":
    // the Action reports the catalog unavailable instead of projecting readiness from unknown credentials.
    if (rawTargets === null) throw Object.assign(new Error('connected_purpose_catalog_unavailable'), { code: 'connected_purpose_catalog_unavailable' });
    if (purpose === 'dictation') {
        const selection = resolveVoiceDictationNativeLocalNeuralModelSelection({ registry, settings, platform });
        const inspection = await inspectVoiceDictationSettingsReadiness({ packId: selection.packId, rawTarget: rawTargets?.[0] ?? null, signal: context.signal });
        const readiness = resolveVoiceDictationReadiness({ registry, settings, platform, connectedPurposes,
            executionMachineId: machine.machineId, executionMachineSelectionKind: machine.selectionKind, localAvailability,
            nativeLocalNeuralModel: inspection.nativeLocalNeuralModel ?? undefined, resolveSavedSecret,
            ...(rawTargets?.[0] && inspection.rawCredentialAuthorization ? { rawCredentialAuthorization: {
                contribution: rawTargets[0].contribution, machineId: machine.machineId, realm: 'daemon' as const,
                phase: 'speech' as const, status: inspection.rawCredentialAuthorization } } : {}) });
        return { providerId: selection.providerId, machineId: machine.machineId, nativeModelPackId: selection.packId,
            ...inspection, readiness, roles: { hear: readiness }, models };
    }
    const entry = voice.providerId ? registry.get(voice.providerId) : null;
    const projection = entry ? projectVoiceProviderSettings(entry, voice.providers[entry.providerId] ?? null) : null;
    const execution = entry?.kind === 'voice.conversation-provider.v1' && entry.declaration?.kind === 'conversation' ? entry.declaration.execution ?? null : null;
    const config = entry ? readVoiceProviderSettingsConfig(voice, entry.providerId) ?? entry.providerSettings?.defaultConfig ?? null : null;
    const inspection = await inspectVoiceProviderReadiness({ machineId: machine.machineId,
        passiveSetup: projectVoiceProviderAgentRealtimePassiveSetup(execution),
        connectedServices: readVoiceProviderConnectedServicesBinding({ providerSettings: entry?.providerSettings ?? null, providerConfig: config }),
        rawTargets, signal: context.signal, isCurrent: input.isCurrent });
    const needsAgent = voice.providerId === 'local_conversation' && localConfig.conversationMode === 'agent';
    const lifetime = captureActiveServerAccountScopeLifetime();
    const agentLifetime = lifetime && areAccountSettingsScopesEqual(scope, lifetime.scope) ? lifetime : null;
    const agentMachineId = needsAgent && voiceAgentAvailability === 'available' ? machine.machineId : null;
    const catalog = getAcpCatalogSnapshot(scope);
    const agentProjection = readReusableDaemonMergedProjectionCacheEntry({ machineId: machine.machineId, serverId,
        sections: DAEMON_AGENT_CATALOG_SECTIONS });
    let projectionInputs = agentProjection?.kind === 'ready' ? agentProjection.inputs : null;
    const rememberedAgent = readLastUsedBackendSelection(scope);
    const selectAgent = (resolvedConfiguredTarget?: ReturnType<typeof projectVoiceConversationAgentSelection>['configuredAgentTarget']) =>
        projectVoiceConversationAgentSelection({ voice, presentation: 'inspection', localAdapter, backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            rememberedAgent, acpCatalogSnapshot: catalog?.catalog.status === 'ready' && !catalog.stale ? catalog.catalog : undefined,
            daemonMergedProjectionInputs: projectionInputs, resolvedConfiguredTarget });
    let agentSelection = selectAgent();
    const agent = agentSelection.configuredAgent;
    let agentTarget = agentSelection.configuredAgentTarget;
    if (agent && !agentTarget?.ok && agentMachineId && agentLifetime && input.isCurrent()) {
        // A configured ACP or contributed Agent may need its catalog before it can be addressed.
        agentTarget = await resolveVoiceConfiguredAgentTarget({
            selection: agent, machineId: agentMachineId, accountScope: agentLifetime.scope, signal: context.signal,
        });
        const admitted = readReusableDaemonMergedProjectionCacheEntry({ machineId: agentMachineId, serverId,
            accountLifetime: agentLifetime, sections: DAEMON_AGENT_CATALOG_SECTIONS });
        if (admitted?.kind === 'ready') projectionInputs = admitted.inputs;
        agentSelection = selectAgent(agentTarget);
    }
    const { selectedAgent } = agentSelection;
    if (selectedAgent && agentMachineId && agentLifetime && input.isCurrent()) {
        await refreshMachineAgents({
            serverId, machineId: agentMachineId, accountLifetime: agentLifetime, target: selectedAgent,
            force: true, signal: context.signal,
        });
    }
    const selectedModel = needsAgent && localConfig.agent.chatModelSource === 'custom' ? localConfig.agent.chatModelSelection : null;
    let modelRoute: Parameters<typeof projectVoiceSelectedAgentReadiness>[2]['modelRoute'];
    if (selectedModel && ('kind' in selectedModel || selectedModel.providerConnectionId)
        && selectedAgent && agentMachineId && agentLifetime && input.isCurrent()) {
        const agentTargetKey = buildBackendTargetKeyV2(selectedAgent);
        const declarations = await loadDaemonMergedProjectionInputs({ machineId: agentMachineId, serverId,
            accountLifetime: agentLifetime, signal: context.signal, sections: PROVIDER_DECLARATION_CONTEXT_SECTIONS });
        const declarationContext = providerDeclarationContext(agentMachineId, declarations?.pluginProjectionV2);
        const teamCatalog = 'kind' in selectedModel ? await loadHomeTeamCredentialModelCatalog({
            scope: agentLifetime.scope, agentTargetKey, machineId: agentMachineId, declarationContext, signal: context.signal,
            assertCurrent: () => {
                if (!input.isCurrent() || !agentLifetime.isCurrent()) {
                    throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                }
            },
        }) : null;
        const personalProvidersEnabled = resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'providers', settings,
            snapshot: featureSnapshot ?? { status: 'loading' }, scope: { scopeKind: 'spawn', serverId } })?.state === 'enabled';
        const modelProjection = teamCatalog || personalProvidersEnabled ? await describeProviderModels({ machineId: agentMachineId, serverId, agentTargetKey,
            mode: 'picker',
            ...('providerConnectionId' in selectedModel ? { currentSelection: selectedModel } : {}),
            ...(teamCatalog ? { teamCredentialResources: [...teamCatalog.resources] } : {}),
        }) : null;
        modelRoute = { selection: selectedModel, agentTargetKey, declarationContext,
            providerSources: personalProvidersEnabled && modelProjection?.status === 'success' ? modelProjection.groups : [],
            teamCredentialResources: modelProjection?.status === 'success' ? modelProjection.teamCredentialResources : [],
            teamCredentialResourceStatusByKey: teamCatalog?.resourceStatusByKey };
    }
    const observedAgents = agentMachineId && agentLifetime
        ? readMachineAgentsForScope(agentLifetime, agentMachineId) : EMPTY_MACHINE_AGENTS;
    const projected = projectVoiceConversationReadiness({ registry, presentation: 'inspection', settings, connectedPurposes, platform,
        availability: resolveVoiceProviderAvailability({ happierVoiceSupported: hostedEnabled, platformOs: platform, local: localAvailability }),
        happierVoiceSupported: hostedEnabled, localInput: localAvailability,
        executionMachineId: machine.machineId, executionMachineSelectedId: machine.selectedMachineId,
        executionMachineSelectionKind: machine.selectionKind, executionMachineOnline: machine.machineId !== null,
        voiceAgentAvailability, agentSelection, observedAgents,
        agentContext: { serverId, machineId: machine.machineId, modelRoute, activeRuntime: getVoiceSessionActiveAgentRuntime(scope) },
        resolveSavedSecret, rawCredentialAuthorizationByContribution: Object.fromEntries((inspection.raw ?? []).map(target => [target.providerId, {
            contribution: target.contribution, machineId: machine.machineId, realm: 'daemon' as const, phase: 'speech' as const, status: target.status }])),
        resolveConnectedAccountEligibility: (selection, declaredServices) => resolveVoiceConnectedAccountTargetEligibility({
            target: selection.target, declaredServices, accounts: state.profile.connectedAccountsV4 ?? [],
            groups: state.profile.connectedAccountGroupsV4 ?? [], resolveAuthentication: getConnectedAccountAuthentication }),
        connectedServices: { accountProfileConnectedServicesV2: state.profile.connectedServicesV2 ?? [],
            labelsByKey: getConnectedMetadataCatalog(scope).labelsByKey, accountGroupsEnabled },
        passiveRealtimeSetupResult: inspection.passive });
    const { localFacts, readiness: selectedReadiness } = projected;
    return { providerId: voice.providerId, machineId: machine.machineId, settings: projection,
        passiveRealtimeSetup: inspection.passive, rawCredentialAuthorization: inspection.raw, models, readiness: selectedReadiness,
        roles: localSelected ? { hear: localFacts.speechReadiness.hear, think: localFacts.thinkReadiness, speak: localFacts.speechReadiness.speak }
            : { hear: selectedReadiness, think: selectedReadiness, speak: selectedReadiness } };
}
