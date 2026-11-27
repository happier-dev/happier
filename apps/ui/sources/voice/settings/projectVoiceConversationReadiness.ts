import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { projectVoiceDefaultAgentSelection, projectVoiceSelectedAgentReadiness } from '@/voice/agent/projectVoiceAgentSelection';
import { projectVoiceConfiguredAgentTarget } from '@/voice/agent/projectVoiceConfiguredAgentTarget';
import { projectVoiceCredentialReadiness } from '@/voice/credentials/credentialReadiness';
import { type resolveLocalVoiceAdapterSettingsFromVoice } from '@/voice/local/localVoiceSettings';
import { projectVoiceProviderSettings, type VoiceProviderRegistry, type VoiceProviderRegistryEntry, type VoiceProviderSettingsProjection } from '@/voice/registry/providerRegistry';
import { projectSelectedUnavailableVoiceProvider, projectVoiceProviderSelectionRows, type VoiceProviderSelectionRow, type SelectedUnavailableVoiceProvider } from '@/voice/registry/providerSelection';
import { projectHostedModeAvailabilityReadiness, resolveVoicePassiveSetupReadiness, resolveVoiceRoleReadiness, type VoiceRoleReadiness, type VoiceRoleReadinessFacts } from '@/voice/registry/readiness';
import type { Settings } from '@/sync/domains/settings/settings';
import { readVoiceProviderSettingsConfig, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { projectVoiceExecutionMachineReadiness } from './executionMachine';
import { projectLocalConversationProviderReadiness, projectLocalConversationReadinessFacts } from './projectLocalConversationReadinessFacts';
import { projectVoiceProviderConnectedServicesCredentialFact, projectVoiceProviderPassiveSetupFacts, type readVoiceProviderPassiveRealtimeSetupResult } from './passiveSetup';
import type { resolveVoiceProviderAvailability } from './resolveVoiceProviderAvailability';

type DefaultAgentInput = Parameters<typeof projectVoiceDefaultAgentSelection>[0];

/** The same synchronous selection feeds page subscriptions and Action catalog loading. */
export function projectVoiceConversationAgentSelection(input: Readonly<{
    voice: VoiceSettings;
    presentation: 'gallery' | 'inspection';
    localAdapter: ReturnType<typeof resolveLocalVoiceAdapterSettingsFromVoice>;
    backendEnabledByTargetKey: Settings['backendEnabledByTargetKey'];
    rememberedAgent: Pick<DefaultAgentInput, 'lastUsedAgent' | 'lastUsedBackendTarget'>;
    acpCatalogSnapshot?: DefaultAgentInput['acpCatalogSnapshot'];
    daemonMergedProjectionInputs?: DefaultAgentInput['daemonMergedProjectionInputs'];
    resolvedConfiguredTarget?: ReturnType<typeof projectVoiceConfiguredAgentTarget>;
}>) {
    const local = input.localAdapter;
    const usesLocalAgent = local.adapterId === 'local_conversation' && local.config.conversationMode === 'agent'
        && (input.presentation === 'gallery' || input.voice.providerId === 'local_conversation');
    const configuredAgent = usesLocalAgent && local.config.agent.agentSource === 'agent' ? local.config.agent : null;
    const projection = input.daemonMergedProjectionInputs;
    const configuredAgentTarget = configuredAgent ? input.resolvedConfiguredTarget ?? projectVoiceConfiguredAgentTarget({
        selection: configuredAgent,
        backendEnabledByTargetKey: input.backendEnabledByTargetKey,
        entries: getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: input.backendEnabledByTargetKey }),
            acpCatalogSnapshot: input.acpCatalogSnapshot,
            backendEnabledByTargetKey: input.backendEnabledByTargetKey,
            mergedProviderProjectionById: projection?.mergedProviderProjectionById,
            mergedBackendProjectionById: projection?.mergedBackendProjectionById,
            discoveredBackendIds: projection?.discoveredBackendIds,
        }),
        mergedProviderProjectionById: projection?.mergedProviderProjectionById,
    }) : null;
    const selectedAgent = configuredAgent
        ? configuredAgentTarget?.ok ? resolveAgentExecutionTargetForBackendTarget({
            backendTarget: configuredAgentTarget.backendTarget, daemonMergedProjectionInputs: projection,
        }) : null
        : projectVoiceDefaultAgentSelection({ ...input.rememberedAgent,
            backendEnabledByTargetKey: input.backendEnabledByTargetKey,
            acpCatalogSnapshot: input.acpCatalogSnapshot, daemonMergedProjectionInputs: projection }).agentTarget;
    return { configuredAgent, configuredAgentTarget, selectedAgent };
}

type LocalFactsInput = Parameters<typeof projectLocalConversationReadinessFacts>[0];
type CredentialInput = Parameters<typeof projectVoiceCredentialReadiness>[0];
type PassiveInput = Parameters<typeof projectVoiceProviderPassiveSetupFacts>[0];
type ConnectedServicesInput = Omit<Parameters<typeof projectVoiceProviderConnectedServicesCredentialFact>[0], 'providerSettings' | 'providerConfig'>;

type VoiceConversationReadinessInput = Readonly<{
    registry: VoiceProviderRegistry;
    settings: Pick<Settings, 'voice' | 'voiceSettingsV1' | 'secrets'>;
    connectedPurposes: LocalFactsInput['connectedPurposes'];
    platform: LocalFactsInput['platform'];
    availability: ReturnType<typeof resolveVoiceProviderAvailability>;
    happierVoiceSupported: boolean;
    localInput?: LocalFactsInput['localInput'];
    executionMachineId: string | null | undefined;
    executionMachineSelectedId: string | null;
    executionMachineSelectionKind?: LocalFactsInput['executionMachineSelectionKind'];
    executionMachineOnline: boolean;
    voiceAgentAvailability: LocalFactsInput['voiceAgentAvailability'];
    voiceAvailability?: LocalFactsInput['voiceAvailability'];
    agentSelection: ReturnType<typeof projectVoiceConversationAgentSelection>;
    observedAgents: Parameters<typeof projectVoiceSelectedAgentReadiness>[1];
    agentContext: Parameters<typeof projectVoiceSelectedAgentReadiness>[2];
    rawCredentialAuthorizationByContribution?: LocalFactsInput['rawCredentialAuthorizationByContribution'];
    resolveSavedSecret?: CredentialInput['resolveSavedSecret'];
    resolveConnectedAccountEligibility?: CredentialInput['resolveConnectedAccountEligibility'];
    connectedServices: ConnectedServicesInput;
    runtimeCapabilityResult?: PassiveInput['runtimeCapabilityResult'];
    passiveRealtimeSetupResult?: ReturnType<typeof readVoiceProviderPassiveRealtimeSetupResult>;
    presentation: 'gallery' | 'inspection';
    selectionRows?: readonly VoiceProviderSelectionRow[];
}>;

type ConversationProviderReadiness = ReturnType<typeof projectVoiceCredentialReadiness> & Readonly<{
    credentialSourceKind: NonNullable<ReturnType<typeof projectVoiceCredentialReadiness>['sourceSelection']>['kind'] | null;
    settingsProjection: VoiceProviderSettingsProjection | null;
    readinessFacts: Required<VoiceRoleReadinessFacts>;
    readiness: VoiceRoleReadiness;
}>;
type ConversationReadinessBase = Readonly<{
    localFacts: ReturnType<typeof projectLocalConversationReadinessFacts>;
    selectedAgentReadiness: ReturnType<typeof projectVoiceSelectedAgentReadiness>;
}>;
type ConversationReadinessRow = ConversationProviderReadiness & Readonly<{
    selection: VoiceProviderSelectionRow;
    checkedReadiness: VoiceRoleReadiness | null;
}>;
type ConversationGalleryReadiness = ConversationReadinessBase & Readonly<{
    rows: ConversationReadinessRow[];
    selectedProviderRow: ConversationReadinessRow | null;
    selectedProviderReadiness: VoiceRoleReadiness | null;
    checkedProviderReadiness: VoiceRoleReadiness | null;
    selectedUnavailableProvider: SelectedUnavailableVoiceProvider | null;
    selectedUnavailableReadiness: VoiceRoleReadiness | null;
}>;
type ConversationInspectionReadiness = ConversationReadinessBase & Readonly<{ readiness: VoiceRoleReadiness }>;

/** Pure composition shared by the settings model and semantic readiness inspection. */
export function projectVoiceConversationReadiness(input: VoiceConversationReadinessInput & { presentation: 'gallery' }): ConversationGalleryReadiness;
export function projectVoiceConversationReadiness(input: VoiceConversationReadinessInput & { presentation: 'inspection' }): ConversationInspectionReadiness;
export function projectVoiceConversationReadiness(input: VoiceConversationReadinessInput): ConversationGalleryReadiness | ConversationInspectionReadiness {
    const { registry, settings, platform } = input;
    const voice = settings.voice;
    const selectedAgentReadiness = projectVoiceSelectedAgentReadiness(input.agentSelection.selectedAgent,
        input.observedAgents, input.agentContext);
    const localFacts = projectLocalConversationReadinessFacts({ registry, voice,
        voiceSettingsV1: settings.voiceSettingsV1, secrets: settings.secrets,
        connectedPurposes: input.connectedPurposes, platform, local: input.availability.local,
        localInput: input.localInput, executionMachineId: input.executionMachineId,
        executionMachineSelectionKind: input.executionMachineSelectionKind,
        voiceAgentAvailability: input.voiceAgentAvailability, voiceAvailability: input.voiceAvailability,
        voiceAgentRuntime: input.agentSelection.configuredAgentTarget?.ok === false ? 'incompatible' : selectedAgentReadiness.runtime,
        selectedAgent: selectedAgentReadiness.selectedAgent,
        rawCredentialAuthorizationByContribution: input.rawCredentialAuthorizationByContribution,
        resolveSavedSecret: input.resolveSavedSecret });
    const selectedEntry = voice.providerId ? registry.get(voice.providerId) : null;
    const selectedMachineReady = typeof input.executionMachineId === 'string'
        && input.executionMachineId.trim().length > 0 && input.executionMachineOnline;
    const passiveRealtimeSetupResult = input.passiveRealtimeSetupResult ?? null;
    const projectProvider = (entry: VoiceProviderRegistryEntry | null, envelope: CredentialInput['envelope'],
        providerId: string | null, modeId: string | null, stage: 'selection' | 'checked' | 'semantic',
        initial?: ConversationProviderReadiness): ConversationProviderReadiness => {
        const settingsProjection = initial ? initial.settingsProjection : entry ? projectVoiceProviderSettings(entry, envelope ?? null) : null;
        const providerModeId = stage === 'semantic' ? settingsProjection?.modeId ?? null : modeId;
        const credential = initial ?? (entry ? projectVoiceCredentialReadiness({ entry, envelope,
            settings, connectedPurposes: input.connectedPurposes, resolveSavedSecret: input.resolveSavedSecret,
            resolveConnectedAccountEligibility: input.resolveConnectedAccountEligibility })
            : { credential: 'unknown' as const, sourceSelection: null, projectedCredential: null,
                accountCredentialReference: null, credentialResolving: false });
        const credentialSourceKind = credential.sourceSelection?.kind ?? null;
        const execution = entry?.kind === 'voice.conversation-provider.v1' && entry.declaration?.kind === 'conversation'
            ? entry.declaration.execution ?? null : null;
        const passiveFacts = projectVoiceProviderPassiveSetupFacts({ execution,
            executionMachineId: input.executionMachineSelectedId,
            executionMachineSelectionKind: input.executionMachineSelectionKind,
            executionMachineOnline: input.executionMachineOnline,
            runtimeCapabilityResult: stage === 'selection' ? null : input.runtimeCapabilityResult ?? null,
            passiveRealtimeSetupResult: stage === 'selection' ? null : passiveRealtimeSetupResult });
        const isLocal = providerId === 'local_conversation' || stage === 'semantic' && providerId === 'local_direct';
        const passiveCredential = stage === 'selection' ? undefined : projectVoiceProviderConnectedServicesCredentialFact({
            ...input.connectedServices, providerSettings: entry?.providerSettings ?? null,
            providerConfig: providerId ? readVoiceProviderSettingsConfig(voice, providerId)
                ?? (stage === 'semantic' ? entry?.providerSettings?.defaultConfig : null) : null });
        const readinessFacts = {
            settings: isLocal ? localFacts.settings : settingsProjection?.status ?? 'unknown',
            serverFeature: isLocal ? localFacts.serverFeature : input.happierVoiceSupported ? 'ready' : 'missing',
            executionMachine: input.executionMachineSelectionKind === 'selected_unknown' ? 'unknown' : isLocal
                ? input.executionMachineSelectionKind === 'selected_unreachable' ? 'incompatible' : localFacts.executionMachine
                : credentialSourceKind === 'connectedAccount' ? selectedMachineReady ? 'ready'
                    : input.executionMachineSelectionKind === 'selected_unreachable' ? 'incompatible' : 'missing'
                    : passiveFacts.executionMachine ?? projectVoiceExecutionMachineReadiness(input.executionMachineSelectionKind,
                        selectedMachineReady ? input.executionMachineId : null),
            credential: isLocal ? localFacts.credential : passiveCredential ?? passiveFacts.credential ?? credential.credential,
            endpoint: localFacts.endpoint, runtime: isLocal ? localFacts.runtime : passiveFacts.runtime ?? localFacts.runtime,
            model: localFacts.model,
        } as const;
        // Checked gallery output overlays the settled probe, while semantic Local readiness
        // keeps the Local owner's facts and declared settings requirements.
        const facts = stage === 'checked' ? { ...readinessFacts, ...passiveFacts,
            ...(passiveCredential ? { credential: passiveCredential } : {}) }
            : stage === 'semantic' && isLocal ? localFacts : readinessFacts;
        const base = { registry, role: entry?.roles[0] ?? 'realtime_conversation', providerId, platform,
            modeId: providerModeId, credentialSourceKind,
            ...(stage === 'checked' ? {} : { settingsRequirements: settingsProjection?.requirements }), facts };
        const projected = stage === 'selection' ? resolveVoiceRoleReadiness(base)
            : resolveVoicePassiveSetupReadiness({ ...base, passiveSetupUnavailable: passiveRealtimeSetupResult?.status === 'unavailable' });
        const descriptorReadiness = providerId === 'local_conversation'
            ? projectLocalConversationProviderReadiness(localFacts, projected) : projected;
        const readiness = stage === 'checked' ? descriptorReadiness : projectHostedModeAvailabilityReadiness({
            providerId: providerId ?? '', role: projected.role, modeId: providerModeId,
            hostedEnabled: input.availability.happier.enabled }) ?? descriptorReadiness;
        return { ...credential, credentialSourceKind, settingsProjection, readinessFacts, readiness };
    };
    if (input.presentation === 'inspection') {
        const readiness = projectProvider(selectedEntry, voice.providerId ? voice.providers[voice.providerId] ?? null : null,
            voice.providerId, null, 'semantic').readiness;
        return { readiness, localFacts, selectedAgentReadiness };
    }
    const rows = (input.selectionRows ?? projectVoiceProviderSelectionRows(voice, registry)).map(row => {
        const projected = projectProvider(row.entry, row.envelope, row.providerId, row.modeId, 'selection');
        return { selection: row, ...projected, checkedReadiness: row.selected
            ? projectProvider(row.entry, row.envelope, row.providerId, row.modeId, 'checked', projected).readiness : null };
    });
    const selectedUnavailableProvider = projectSelectedUnavailableVoiceProvider(voice, registry);
    const selectedUnavailableReadiness = selectedUnavailableProvider ? resolveVoiceRoleReadiness({ registry,
        role: selectedUnavailableProvider.entry?.roles[0] ?? 'realtime_conversation', providerId: selectedUnavailableProvider.providerId,
        platform, modeId: selectedUnavailableProvider.modeId,
        settingsRequirements: selectedUnavailableProvider.settingsProjection?.requirements,
        facts: { settings: selectedUnavailableProvider.settingsProjection?.status ?? 'unknown' } }) : null;
    const selectedProviderRow = rows.find(row => row.selection.selected) ?? null;
    const selectedProviderReadiness = selectedProviderRow?.readiness ?? selectedUnavailableReadiness;
    const checkedProviderReadiness = selectedProviderRow?.checkedReadiness ?? selectedUnavailableReadiness;
    return { rows, selectedProviderRow, selectedProviderReadiness, checkedProviderReadiness,
        selectedUnavailableProvider, selectedUnavailableReadiness, localFacts, selectedAgentReadiness };
}
