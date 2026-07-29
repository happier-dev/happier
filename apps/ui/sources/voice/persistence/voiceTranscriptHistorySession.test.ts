import { describe, expect, it, vi } from 'vitest';

import {
    buildVoiceTranscriptHistorySessionMetadata,
    isVoiceTranscriptHistorySession,
    resolveDirectMediaTranscriptSession,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from './voiceTranscriptHistorySession';

describe('voice transcript history session', () => {
    it('uses the approved hosted hidden-session identity', () => {
        expect(VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG)
            .toBe('system:voice-transcript-history:v1');
        expect(buildVoiceTranscriptHistorySessionMetadata()).toEqual({
            systemSessionV1: {
                v: 1,
                key: 'voice_transcript_history',
                hidden: true,
            },
        });
        expect(isVoiceTranscriptHistorySession({
            active: false,
            metadata: buildVoiceTranscriptHistorySessionMetadata(),
        })).toBe(true);
        expect(isVoiceTranscriptHistorySession({
            active: true,
            metadata: buildVoiceTranscriptHistorySessionMetadata(),
        })).toBe(false);
    });

    it('hydrates and returns a real requested target session without acquiring history', async () => {
        const ensureTargetSession = vi.fn(async () => undefined);
        const ensureHistorySession = vi.fn(async () => 'history');

        await expect(resolveDirectMediaTranscriptSession({
            ensureTargetSession,
            ensureHistorySession,
        }, {
            requestedTargetSessionId: ' target-session ',
        })).resolves.toBe('target-session');

        expect(ensureTargetSession).toHaveBeenCalledWith('target-session');
        expect(ensureHistorySession).not.toHaveBeenCalled();
    });

    it('reuses the targetless hosted history owner', async () => {
        const ensureTargetSession = vi.fn(async () => undefined);
        const ensureHistorySession = vi.fn(async () => 'history-session');

        await expect(resolveDirectMediaTranscriptSession({
            ensureTargetSession,
            ensureHistorySession,
        }, {
            requestedTargetSessionId: null,
        })).resolves.toBe('history-session');

        expect(ensureTargetSession).not.toHaveBeenCalled();
        expect(ensureHistorySession).toHaveBeenCalledTimes(1);
    });
});
