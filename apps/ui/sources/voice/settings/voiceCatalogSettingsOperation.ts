import { Platform } from 'react-native';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { storage } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { createVoiceSettingsCatalogClient } from '@/voice/credentials/bundledConversationClient';
import { getExternalVoiceProviderRegistration, subscribeExternalVoiceProviderRegistrations } from '@/voice/registry/externalVoiceProviderRegistrations';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { fetchVoiceSettingsCatalog } from './panels/realtime/voiceCatalog';
import { playRealtimeCatalogPreview, stopRealtimeCatalogPreview } from './panels/realtime/catalogPreview';

export async function invokeVoiceCatalogSettingsOperation(entry: VoiceProviderRegistryEntry, registry: VoiceProviderRegistry, operation: 'preview' | 'stop', context: SettingOperationContext): Promise<SettingOperationResult> {
    if (operation === 'preview' && context.input?.kind !== 'voice_preview') return { status: 'unavailable', reason: 'operation_input_required' };
    if (operation === 'stop' && context.input) return { status: 'unavailable', reason: 'operation_input_invalid' };
    const descriptor = entry.providerSettings;
    if (!descriptor) return { status: 'unavailable', reason: 'provider_settings_unavailable' };
    const registration = getExternalVoiceProviderRegistration(entry.providerId);
    const scope = storage.getState().settingsScope;
    const captured = await context.readSettings();
    if (captured.voice.providerId !== entry.providerId) return { status: 'unavailable', reason: 'provider_not_selected' };
    const voiceMaterial = JSON.stringify(captured.voice);
    const current = () => !context.signal?.aborted && context.isCurrent()
        && registry.get(entry.providerId)?.providerSettings === descriptor
        && getExternalVoiceProviderRegistration(entry.providerId) === registration
        && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
        && JSON.stringify(storage.getState().settings.voice) === voiceMaterial;
    if (!current()) return { status: 'cancelled' };
    if (operation === 'stop') return { status: 'completed', value: { stopped: stopRealtimeCatalogPreview(entry.providerId) } };
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.userActivation?.isActive) return { status: 'unavailable', reason: 'audio_user_gesture_required' };
    const client = createVoiceSettingsCatalogClient(entry.providerId, () => {
        const voice = storage.getState().settings.voice;
        const envelope = voice.providers[entry.providerId];
        if (!current() || envelope && envelope.schemaVersion !== descriptor.schemaVersion) throw new Error('provider_settings_retired');
        const config = descriptor.parseConfig(envelope ? readVoiceProviderSettingsConfig(voice, entry.providerId) : descriptor.defaultConfig);
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('provider_settings_invalid');
        return config as Readonly<Record<string, unknown>>;
    });
    if (!client) return { status: 'unavailable', reason: 'voice_catalog_unavailable' };
    try {
        const rows = await fetchVoiceSettingsCatalog(client, context.signal);
        if (!current() || JSON.stringify((await context.readSettings()).voice) !== voiceMaterial) return { status: 'cancelled' };
        const voiceId = context.input?.kind === 'voice_preview' ? context.input.voiceId : null;
        const row = rows.find(candidate => candidate.id === voiceId);
        if (!row) return { status: 'unavailable', reason: 'voice_not_found' };
        return await playRealtimeCatalogPreview({ providerId: entry.providerId, row, signal: context.signal, isCurrent: current,
            subscribeCurrent(listener) {
                const unsubscribeSettings = storage.subscribe(listener);
                const unsubscribeRegistration = subscribeExternalVoiceProviderRegistrations(listener);
                return () => { unsubscribeSettings(); unsubscribeRegistration(); };
            },
        });
    } catch {
        return current() ? { status: 'unavailable', reason: 'voice_catalog_unavailable' } : { status: 'cancelled' };
    }
}
