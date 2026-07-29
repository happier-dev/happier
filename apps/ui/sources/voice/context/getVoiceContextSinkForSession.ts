import { storage } from '@/sync/domains/state/storage';
import { getVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import {
    getVoiceAdapterRegistry,
    resolveVoiceAdapterContextChannel,
} from '@/voice/session/voiceAdapterRegistry';
import type { VoiceContextSink } from './VoiceContextSink';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

function createProjectedContextSink(adapterId: string, voiceSettings: unknown): VoiceContextSink | null {
    const channel = resolveVoiceAdapterContextChannel(adapterId, voiceSettings);
    if (!channel) return null;
    return {
        sendContextualUpdate: (_sessionId, update) => channel.sendContextualUpdate(update),
        sendTextMessage: (_sessionId, text) => channel.sendTextMessage(text),
        ...(channel.announceAssistantText
            ? { announceAssistantText: (_sessionId: string, text: string) => channel.announceAssistantText?.(text) }
            : {}),
    };
}

function resolveActiveOwnerAdapterId(): string | null {
    const snapshot = getVoiceSessionSnapshot();
    if (snapshot.status !== 'connected' && snapshot.status !== 'connecting') {
        return null;
    }
    return snapshot.adapterId;
}

export function getVoiceContextSinkForSession(_sessionId: string): VoiceContextSink | null {
    const settings = storage.getState().settings as any;
    const voiceSettings = voiceSettingsParse(settings?.voice);
    const activeOwnerAdapterId = resolveActiveOwnerAdapterId();
    if (activeOwnerAdapterId) {
        return createProjectedContextSink(activeOwnerAdapterId, voiceSettings);
    }

    const providerId = resolveVoiceProviderIdFromSettings(voiceSettings);
    if (!providerId) return null;
    // Local agent context can remain active through its canonical binding even
    // while the surface snapshot is disconnected. Realtime channels, however,
    // must never revive a stale SDK/session object from selected settings alone.
    const selectedAdapter = getVoiceAdapterRegistry().get(providerId);
    return selectedAdapter?.engineKind === 'local'
        ? createProjectedContextSink(providerId, voiceSettings)
        : null;
}
