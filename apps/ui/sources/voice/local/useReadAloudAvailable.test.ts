import { afterEach, describe, expect, it, vi } from 'vitest';

import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import { resolveReadAloudAvailable } from './useReadAloudAvailable';

const local = (tts: Record<string, unknown>) => voiceSettingsParse({
    providerId: 'local_conversation',
    adapters: { local_conversation: { tts } },
});

describe('resolveReadAloudAvailable', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('parses the TTS settings once per voice record, however many readers ask', () => {
        const parse = vi.spyOn(VoiceLocalTtsSchema, 'safeParse');
        const settings = { voice: local({ provider: 'device' }) };

        for (let reader = 0; reader < 50; reader += 1) {
            expect(resolveReadAloudAvailable(settings)).toBe(true);
            // An unrelated store update replaces the settings container but keeps the voice record.
            expect(resolveReadAloudAvailable({ ...settings })).toBe(true);
        }
        expect(parse).toHaveBeenCalledTimes(1);
    });

    it('recomputes when the voice record changes', () => {
        const unconfigured = { voice: local({ provider: 'openai_compat' }) };
        const configured = { voice: local({ provider: 'openai_compat', openaiCompat: { baseUrl: 'http://localhost:8880/v1' } }) };

        expect(resolveReadAloudAvailable(unconfigured)).toBe(false);
        expect(resolveReadAloudAvailable(configured)).toBe(true);
        expect(resolveReadAloudAvailable(unconfigured)).toBe(false);
    });
});
