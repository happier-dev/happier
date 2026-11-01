import { describe, expect, it } from 'vitest';

import { isVoiceBargeInEnabled } from './localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

describe('isVoiceBargeInEnabled', () => {
    it('follows the settings schema default (on) when bargeInEnabled is unset', () => {
        const settings = { voice: voiceSettingsParse({ providerId: 'local_conversation' }) };
        expect(isVoiceBargeInEnabled(settings)).toBe(true);
    });

    it('is off only when explicitly disabled', () => {
        const settings = { voice: voiceSettingsParse({ providerId: 'local_conversation', adapters: { local_conversation: { tts: { bargeInEnabled: false } } } }) };
        expect(isVoiceBargeInEnabled(settings)).toBe(false);
    });
});
