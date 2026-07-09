import { describe, expect, it } from 'vitest';

import {
    resolveStoredVoiceProviderId,
    resolveVoiceProviderId,
} from './resolveVoiceProviderId';

describe('resolveVoiceProviderId', () => {
    it('preserves the stored local provider id for settings and fallback configuration', () => {
        expect(resolveStoredVoiceProviderId(' local_conversation ')).toBe('local_conversation');
        expect(resolveVoiceProviderId(' local_conversation ')).toBe('local_conversation');
    });

    it('preserves local providers instead of applying platform fallback rewrites', () => {
        expect(resolveVoiceProviderId('local_direct')).toBe('local_direct');
        expect(resolveVoiceProviderId(' local_conversation ')).toBe('local_conversation');
    });

    it('keeps realtime and off provider resolution unchanged', () => {
        expect(resolveVoiceProviderId('realtime_elevenlabs')).toBe('realtime_elevenlabs');
        expect(resolveVoiceProviderId('off')).toBe('off');
    });
});
