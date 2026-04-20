import { describe, expect, it } from 'vitest';

import type { VoiceMachineErrorKind } from './voiceConversationRuntimeTypes';
import { resolveVoiceMachineErrorTranslationKey } from './voiceMachineErrorCopy';

const voiceMachineErrorKinds = [
    'mic_permission_denied',
    'mic_ended',
    'mic_plateau',
    'transport_disconnect',
    'provider_error',
    'audio_context_suspended',
    'stt_timeout',
    'tts_failed',
    'turn_aborted',
] as const satisfies ReadonlyArray<VoiceMachineErrorKind>;

describe('voiceMachineErrorCopy', () => {
    it('maps every machine error kind onto one canonical translation key', () => {
        for (const kind of voiceMachineErrorKinds) {
            expect(resolveVoiceMachineErrorTranslationKey(kind)).toBe(
                `settingsVoice.local.machineErrors.${kind}`,
            );
        }
    });
});
