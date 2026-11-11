import { Platform } from 'react-native';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { storage } from '@/sync/domains/state/storage';
import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { BundledSpeechDaemonClient } from '@/voice/credentials/bundledSpeechClient';
import { resolveVoiceExecutionMachineId } from './executionMachine';
import { createVoiceSettingsCatalogClient } from '@/voice/credentials/bundledConversationClient';
import { getExternalVoiceProviderRegistration, subscribeExternalVoiceProviderRegistrations } from '@/voice/registry/externalVoiceProviderRegistrations';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { fetchVoiceSettingsCatalog, projectVoiceSettingsCatalogList, readDeclaredVoiceSettingsCatalog } from './panels/realtime/voiceCatalog';
import { playRealtimeCatalogPreview, stopRealtimeCatalogPreview } from './panels/realtime/catalogPreview';

export async function invokeVoiceCatalogSettingsOperation(entry: VoiceProviderRegistryEntry, registry: VoiceProviderRegistry, operation: 'preview' | 'stop' | 'list' | 'retry', context: SettingOperationContext): Promise<SettingOperationResult> {
    if (operation === 'preview' && context.input?.kind !== 'voice_preview') return { status: 'unavailable', reason: 'operation_input_required' };
    if (operation !== 'preview' && context.input) return { status: 'unavailable', reason: 'operation_input_invalid' };
    const descriptor = entry.providerSettings;
    if (!descriptor) return { status: 'unavailable', reason: 'provider_settings_unavailable' };
    const registration = getExternalVoiceProviderRegistration(entry.providerId);
    const captured = await context.readSettings();
    const local = captured.voice.providerId === 'local_conversation' ? readLocalConversationVoiceSettings(captured.voice)
        : captured.voice.providerId === 'local_direct' ? readLocalDirectVoiceSettings(captured.voice) : null;
    const selectedProviderId = entry.kind === 'voice.speech-engine.v1' ? local?.tts.provider : captured.voice.providerId;
    if ((operation === 'preview' || operation === 'stop') && selectedProviderId !== entry.providerId) return { status: 'unavailable', reason: 'provider_not_selected' };
    const machineId = resolveVoiceExecutionMachineId();
    const current = () => !context.signal?.aborted && context.isCurrent();
    const playbackCurrent = () => {
        if (!current() || registry.get(entry.providerId)?.providerSettings !== descriptor
            || getExternalVoiceProviderRegistration(entry.providerId) !== registration
            || entry.kind === 'voice.speech-engine.v1' && resolveVoiceExecutionMachineId() !== machineId) return false;
        const voice = storage.getState().settings.voice;
        if (entry.kind !== 'voice.speech-engine.v1') return voice.providerId === entry.providerId;
        const local = voice.providerId === 'local_conversation' ? readLocalConversationVoiceSettings(voice)
            : voice.providerId === 'local_direct' ? readLocalDirectVoiceSettings(voice) : null;
        return local?.tts.provider === entry.providerId;
    };
    if (!current()) return { status: 'cancelled' };
    if (operation === 'stop') return { status: 'completed', value: { stopped: stopRealtimeCatalogPreview(entry.providerId) } };
    if (operation === 'preview' && Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.userActivation?.isActive) return { status: 'unavailable', reason: 'audio_user_gesture_required' };
    const client = entry.kind === 'voice.speech-engine.v1'
        ? { fetchVoiceCatalog: (signal?: AbortSignal | null) => new BundledSpeechDaemonClient().fetchCatalog(entry, 'voices', signal, machineId) }
        : createVoiceSettingsCatalogClient(entry.providerId, () => {
        const voice = captured.voice;
        const envelope = voice.providers[entry.providerId];
        if (!current() || envelope && envelope.schemaVersion !== descriptor.schemaVersion) throw new Error('provider_settings_retired');
        const config = descriptor.parseConfig(envelope ? readVoiceProviderSettingsConfig(voice, entry.providerId) : descriptor.defaultConfig);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('provider_settings_invalid');
        return config as Readonly<Record<string, unknown>>;
    });
    const declaredRows = 'declaration' in entry && entry.declaration ? readDeclaredVoiceSettingsCatalog(entry.declaration) : null;
    if (!declaredRows && !client) return { status: 'unavailable', reason: 'voice_catalog_unavailable' };
    try {
        const rows = declaredRows ?? await fetchVoiceSettingsCatalog(client!, context.signal);
        if (!current()) return { status: 'cancelled' };
        if (operation === 'list' || operation === 'retry') return { status: 'completed', value: { rows: projectVoiceSettingsCatalogList(rows) } };
        const voiceId = context.input?.kind === 'voice_preview' ? context.input.voiceId : null;
        const row = rows.find(candidate => candidate.id === voiceId);
        if (!row) return { status: 'unavailable', reason: 'voice_not_found' };
        return await playRealtimeCatalogPreview({ providerId: entry.providerId, row, signal: context.signal, isCurrent: playbackCurrent,
            subscribeCurrent(listener) {
                const unsubscribeSettings = storage.subscribe(listener, { settings: ['voice'], settingsScope: true, profileScope: true });
                const unsubscribeRegistration = subscribeExternalVoiceProviderRegistrations(listener);
                return () => { unsubscribeSettings(); unsubscribeRegistration(); };
            },
        });
    } catch (error) {
        if (!current()) return { status: 'cancelled' };
        if (readActionErrorCodeV1(error)) throw error;
        return { status: 'unavailable', reason: 'voice_catalog_unavailable' };
    }
}
