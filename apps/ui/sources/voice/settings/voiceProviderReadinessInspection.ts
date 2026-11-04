import type { ConnectedServiceBindingsV1, DaemonVoiceInferenceModelStatus, PluginContributionIdentityV1, VoiceRawCredentialGrantDeclaration } from '@happier-dev/protocol';
import { VoiceRuntimePlatformSchema } from '@happier-dev/protocol/voice/realtime/capabilities';
import { getDefaultModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { resolveRequiredRecipientContractApprovalDigestV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import type { VoiceCredentialSourceSelection } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { Platform } from 'react-native';
import type { SettingOperationContext } from '@/components/settings/catalog/settingDeclarations';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { resolveAccountVoiceCredentialSourceSelection, resolveAccountVoiceCredentialStatus, resolveSelectedVoiceCredentialRawGrants } from '@/voice/credentials/accountVoiceCredential';
import { inspectRawCredentialAuthorizationReadiness } from '@/voice/credentials/rawCredentialAuthorizationClient';
import { parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings, resolveLocalVoiceAdapterSettingsFromVoice } from '@/voice/local/localVoiceSettings';
import { projectVoiceProviderCredentialReadiness, projectVoiceProviderSettings, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectVoiceProviderAgentRealtimePassiveSetup, projectVoiceProviderConnectedServicesCredentialFact, projectVoiceProviderPassiveSetupFacts, readVoiceProviderConnectedServicesBinding, readVoiceProviderPassiveRealtimeSetupResult, type VoiceProviderAgentRealtimePassiveSetup } from './passiveSetup';
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
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { projectVoiceConfiguredAgentTarget } from '@/voice/agent/projectVoiceConfiguredAgentTarget';
import { resolveVoiceConnectedAccountTargetEligibility, type VoiceConnectedAccountTargetEligibility } from '@/voice/credentials/sourceEligibility';
import { readDeviceSpeechRecognitionAvailability } from '@/voice/input/deviceSpeechRecognitionAvailability';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { projectHostedModeAvailabilityReadiness, resolveVoicePassiveSetupReadiness, resolveVoiceProviderCredentialFact } from '@/voice/registry/readiness';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { readDaemonVoiceInferenceClientErrorCode } from '@/voice/runtime/daemonInference/daemonVoiceInferenceErrors';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { resolveDaemonSpeechPcmCaptureAvailability } from '@/voice/runtime/daemonInference/resolveDaemonSpeechPcmCaptureAvailability';
import { readPassiveBrowserWebSpeechCapability } from './browserWebSpeechCapability';
import { projectLocalConversationProviderReadiness, projectLocalConversationReadinessFacts } from './projectLocalConversationReadinessFacts';
import { resolveVoiceProviderAvailability } from './resolveVoiceProviderAvailability';
import { resolveVoiceDaemonDirectRouteAvailability, resolveVoiceDaemonModelAvailabilityFromCatalogState, resolveVoiceProviderLocalAvailability } from './voiceProviderLocalAvailability';
import type { VoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { captureDaemonVoiceModelCatalogObservation } from './panels/modelCatalog/daemonVoiceModelCatalogObservation';

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
    const localConfig = resolveLocalVoiceAdapterSettings(runtimeSettings).config;
    const stt = parseLocalVoiceSttSettings(localConfig.stt);
    const tts = parseLocalVoiceTtsSettings(localConfig.tts);
    const localSelected = voice.providerId === 'local_conversation' || voice.providerId === 'local_direct';
    const requireStt = (purpose === 'dictation' || localSelected) && stt.provider === 'local_neural'
        && resolveLocalNeuralExecutionPolicy({ requestedExecution: stt.localNeural.execution, platformOs: platform }).preferredExecution === 'daemon';
    const requireTts = purpose === 'conversation' && localSelected && tts.provider === 'local_neural'
        && resolveLocalNeuralExecutionPolicy({ requestedExecution: tts.localNeural.execution, platformOs: platform }).preferredExecution === 'daemon';
    const [hostedEnabled, voiceAgentEnabled, daemonFeatureEnabled, accountGroupsEnabled] = await Promise.all([
        context.isFeatureEnabled?.('voice.happierVoice') ?? false, context.isFeatureEnabled?.('voice.agent') ?? false,
        context.isFeatureEnabled?.('voice.daemonInference') ?? false, context.isFeatureEnabled?.('connectedServices.accountGroups') ?? false,
    ]);
    const state = storage.getState();
    const scope = state.settingsScope;
    const appliedServer = getAppliedActiveServerSnapshot();
    const serverId = scope?.serverId ?? appliedServer.serverId;
    const featureSnapshot = getCachedServerFeaturesSnapshot({ serverId });
    const serverFeatures = featureSnapshot?.status === 'ready' ? featureSnapshot.features : null;
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
            const code = readDaemonVoiceInferenceClientErrorCode(error);
            modelError = code === 'feature_disabled' || code === 'machine_unreachable' || code === 'runtime_unavailable'
                || code === 'unsupported_runtime_family' || code === 'request_timeout' ? code : 'internal_error';
        }
    }
    const modelAvailability = resolveVoiceDaemonModelAvailabilityFromCatalogState({ loading: false, errorCode: modelError,
        statuses: models, selectedSttPackId: stt.localNeural.assetId, selectedTtsPackId: tts.localNeural.assetId, requireStt, requireTts });
    const selectedMachine = machine.machineId ? resolveMachineForActiveServerFromState(state, machine.machineId, { serverId }) : null;
    const credentials = (requireStt || requireTts) && machine.machineId && input.isCurrent()
        ? await TokenStorage.getCredentialsForServerUrl(appliedServer.serverUrl, { serverId: appliedServer.serverId }) : null;
    const nativeDeviceSpeechRecognition = platform === 'web' || stt.provider !== 'device' ? 'unknown'
        : await import('expo-speech-recognition').then(({ ExpoSpeechRecognitionModule }) => readDeviceSpeechRecognitionAvailability(ExpoSpeechRecognitionModule), () => 'unknown' as const);
    const localAvailability = resolveVoiceProviderLocalAvailability({ serverFeatures, daemonFeatureEnabled, platformOs: platform,
        browserSpeechCapability: readPassiveBrowserWebSpeechCapability({ platformOs: platform }), nativeDeviceSpeechRecognition,
        daemonModelState: modelAvailability.modelState, daemonRuntimeState: modelAvailability.runtimeState,
        daemonPcmCapture: resolveDaemonSpeechPcmCaptureAvailability(), daemonDirectRouteAvailability: resolveVoiceDaemonDirectRouteAvailability({
            serverFeatures, credentials, endpoint: selectedMachine?.daemonState?.peerMediation?.loopback?.endpoint ?? null }) });
    const purposeSnapshot = getConnectedAccountCatalogValue(scope, 'purposes');
    const connectedPurposes = context.services?.readConnectedAccountPurposes
        ? await context.services.readConnectedAccountPurposes(context.signal)
        : purposeSnapshot.status === 'ready' && !purposeSnapshot.stale ? purposeSnapshot.value : null;
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
    const agent = localConfig.conversationMode === 'agent' && localConfig.agent.agentSource === 'agent' ? localConfig.agent : null;
    const catalog = getAcpCatalogSnapshot(scope);
    const agentProjection = readReusableDaemonMergedProjectionCacheEntry({ machineId: machine.machineId, serverId });
    const projectionInputs = agentProjection?.kind === 'ready' ? agentProjection.inputs : null;
    const agentEntries = getResolvedBackendCatalogEntries({ enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSnapshot: catalog?.catalog.status === 'ready' && !catalog.stale ? catalog.catalog : undefined, backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById,
            mergedBackendProjectionById: projectionInputs?.mergedBackendProjectionById, discoveredBackendIds: projectionInputs?.discoveredBackendIds });
    const agentTarget = agent ? projectVoiceConfiguredAgentTarget({ selection: agent, entries: agentEntries,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey, mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById }) : null;
    const localFacts = projectLocalConversationReadinessFacts({ registry, voice, voiceSettingsV1: settings.voiceSettingsV1,
        secrets: settings.secrets, connectedPurposes, platform, localInput: localAvailability,
        local: resolveVoiceProviderAvailability({ happierVoiceSupported: hostedEnabled, platformOs: platform, local: localAvailability }).local,
        executionMachineId: machine.machineId, executionMachineSelectionKind: machine.selectionKind, voiceAgentEnabled,
        voiceAgentRuntime: agentTarget === null ? 'unknown' : agentTarget.ok ? 'ready' : 'incompatible', resolveSavedSecret,
        rawCredentialAuthorizationByContribution: Object.fromEntries((inspection.raw ?? []).map(target => [target.providerId, {
            contribution: target.contribution, machineId: machine.machineId, realm: 'daemon' as const, phase: 'speech' as const, status: target.status }])) });
    const contribution = entry?.kind === 'voice.conversation-provider.v1' && entry.declaration?.kind === 'conversation'
        ? { pluginId: entry.pluginId, localId: entry.declaration.id } : null;
    const accountCredential = entry?.accountCredentialSlot && contribution ? resolveAccountVoiceCredentialStatus({ settings, contribution,
        credentialSlotId: entry.accountCredentialSlot.id,
        requiredRecipientContractDigest: resolveRequiredRecipientContractApprovalDigestV1(entry.accountCredentialSlot.recipientContract), resolveSavedSecret }) : null;
    const declaration = entry?.kind === 'voice.conversation-provider.v1' && entry.declaration?.kind === 'conversation' ? entry.declaration.credentials : null;
    let sourceSelection: (VoiceCredentialSourceSelection & Readonly<{ connectedAccountEligibility: VoiceConnectedAccountTargetEligibility }>) | null = null;
    if (contribution && declaration) {
        try {
            const source = resolveAccountVoiceCredentialSourceSelection({ settings, connectedPurposes, contribution,
                credentialSlotId: declaration.slot.id, purpose: { consumer: contribution, purpose: declaration.slot.purpose }, machineId: null }).selection;
            sourceSelection = { ...source, connectedAccountEligibility: source.kind === 'connectedAccount'
                ? resolveVoiceConnectedAccountTargetEligibility({ target: source.target,
                    declaredServices: declaration.sources.flatMap(candidate => candidate.kind === 'connectedAccount'
                        ? [typeof candidate.service === 'string' ? { pluginId: contribution.pluginId, localId: candidate.service } : candidate.service] : []),
                    accounts: state.profile.connectedAccountsV4 ?? [], groups: state.profile.connectedAccountGroupsV4 ?? [], resolveAuthentication: getConnectedAccountAuthentication }) : 'unusable' as const };
        } catch { sourceSelection = null; }
    }
    const credential = entry ? resolveVoiceProviderCredentialFact({ sourceKind: entry.source.kind,
        projectedCredential: projectVoiceProviderCredentialReadiness(entry, voice.providers[entry.providerId] ?? null, {
            sourceSelection, savedSecret: { status: accountCredential?.status === 'unknown' ? 'unknown' : accountCredential?.status === 'ready' ? 'ready' : 'missing' } }),
        hasAccountCredentialSlot: Boolean(entry.accountCredentialSlot), hasAccountCredentialReference: accountCredential?.status === 'ready',
        accountCredentialApprovalRequired: entry.source.kind === 'external' && accountCredential?.status === 'review_required' }) : 'unknown';
    const passiveFacts = projectVoiceProviderPassiveSetupFacts({ execution, executionMachineId: machine.selectedMachineId,
        executionMachineSelectionKind: machine.selectionKind, executionMachineOnline: machine.machineId !== null,
        runtimeCapabilityResult: null, passiveRealtimeSetupResult: inspection.passive });
    const passiveCredential = projectVoiceProviderConnectedServicesCredentialFact({ providerSettings: entry?.providerSettings ?? null,
        providerConfig: config, accountProfileConnectedServicesV2: state.profile.connectedServicesV2 ?? [],
        labelsByKey: getConnectedMetadataCatalog(scope).labelsByKey, accountGroupsEnabled });
    const readiness = resolveVoicePassiveSetupReadiness({ registry, providerId: voice.providerId, role: entry?.roles[0] ?? 'realtime_conversation',
        platform, modeId: projection?.modeId, settingsRequirements: projection?.requirements, credentialSourceKind: sourceSelection?.kind,
        passiveSetupUnavailable: inspection.passive?.status === 'unavailable', facts: localSelected ? localFacts : {
            settings: projection?.status ?? 'unknown', serverFeature: hostedEnabled ? 'ready' : 'missing', endpoint: localFacts.endpoint,
            runtime: passiveFacts.runtime ?? localFacts.runtime, model: localFacts.model,
            executionMachine: machine.selectionKind === 'selected_unknown' ? 'unknown' : sourceSelection?.kind === 'connectedAccount' ? machine.selectionKind === 'selected_unreachable' ? 'incompatible' : machine.machineId ? 'ready' : 'missing'
                : passiveFacts.executionMachine ?? 'missing', credential: passiveCredential ?? passiveFacts.credential ?? credential } });
    const selectedReadiness = projectHostedModeAvailabilityReadiness({ providerId: voice.providerId ?? '', role: readiness.role,
        modeId: projection?.modeId ?? null, hostedEnabled }) ?? (voice.providerId === 'local_conversation'
            ? projectLocalConversationProviderReadiness(localFacts, readiness) : readiness);
    return { providerId: voice.providerId, machineId: machine.machineId, settings: projection,
        passiveRealtimeSetup: inspection.passive, rawCredentialAuthorization: inspection.raw, models, readiness: selectedReadiness,
        roles: localSelected ? { hear: localFacts.speechReadiness.hear, think: localFacts.thinkReadiness, speak: localFacts.speechReadiness.speak }
            : { hear: selectedReadiness, think: selectedReadiness, speak: selectedReadiness } };
}
