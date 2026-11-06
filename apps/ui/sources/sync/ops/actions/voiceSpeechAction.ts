import type { VoiceSayActionResult } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { toSpeechText } from '@happier-dev/protocol/voice/speechText';
import type { Settings } from '@/sync/domains/settings/settings';
import { localVoiceTtsController } from '@/voice/backends/tts/localVoiceTtsController';
import { parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettingsFromVoice } from '@/voice/local/localVoiceSettings';
import { readSafeVoiceRuntimeFailureCode } from '@/voice/runtime/voiceRuntimeFailureCode';

/** The Action port adapts the incumbent output owner; it owns no speech state. */
export async function executeVoiceSpeechAction(
    actionId: 'ui.voice_global.say.start' | 'ui.voice_global.say.stop',
    input: Readonly<{ text?: string }>,
    settings: Pick<Settings, 'voice'>,
    signal?: AbortSignal,
): Promise<VoiceSayActionResult> {
    if (actionId === 'ui.voice_global.say.stop') {
        localVoiceTtsController.stopSay();
        return { status: 'completed' };
    }
    const text = toSpeechText(input.text ?? '').trim();
    if (!text) return { status: 'completed' };
    const { config } = resolveLocalVoiceAdapterSettingsFromVoice(settings.voice);
    try {
        return await localVoiceTtsController.say({ text, settings, signal,
            tts: parseLocalVoiceTtsSettings(config.tts), networkTimeoutMs: config.networkTimeoutMs,
            onSpeaking: () => {},
        });
    } catch (error) {
        return { status: 'unavailable', code: readSafeVoiceRuntimeFailureCode(error) ?? 'tts_failed' };
    }
}
