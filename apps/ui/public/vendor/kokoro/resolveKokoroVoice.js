/** Shared by the browser worker and the main-thread Kokoro runtime. */
export const KOKORO_WEB_DEFAULT_VOICE_ID = 'af_heart';

/**
 * @param {string | null | undefined} voiceId
 * @param {Iterable<string>} catalogVoiceIds
 * @returns {string}
 */
export function resolveKokoroWebVoiceId(voiceId, catalogVoiceIds) {
    const requested = typeof voiceId === 'string' ? voiceId.trim() : '';
    if (requested) {
        for (const id of catalogVoiceIds) {
            if (id === requested) return requested;
        }
    }
    return KOKORO_WEB_DEFAULT_VOICE_ID;
}
