import { describe, expect, it } from 'vitest';

import {
    resolveContinuousVoiceProviderId,
    resolveStoredVoiceProviderId,
    resolveVoiceProviderId,
} from './resolveVoiceProviderId';

describe('resolveVoiceProviderId', () => {
    it('preserves the stored local provider id for settings and fallback configuration', () => {
        expect(resolveStoredVoiceProviderId(' local_conversation ')).toBe('local_conversation');
        expect(resolveVoiceProviderId(' local_conversation ')).toBe('local_conversation');
    });

    it('maps local web providers to realtime for continuous-mode resolution', () => {
        expect(resolveContinuousVoiceProviderId('local_direct', { platformOs: 'web' })).toBe('realtime_elevenlabs');
        expect(resolveContinuousVoiceProviderId(' local_conversation ', { platformOs: 'web' })).toBe('realtime_elevenlabs');
    });

    it('keeps non-web continuous provider resolution unchanged', () => {
        expect(resolveContinuousVoiceProviderId('local_conversation', { platformOs: 'ios' })).toBe('local_conversation');
        expect(resolveContinuousVoiceProviderId('realtime_elevenlabs', { platformOs: 'web' })).toBe('realtime_elevenlabs');
        expect(resolveContinuousVoiceProviderId('off', { platformOs: 'web' })).toBe('off');
    });
});
