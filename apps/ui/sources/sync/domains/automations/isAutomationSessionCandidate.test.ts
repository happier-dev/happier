import { describe, expect, it } from 'vitest';

import { isAutomationSessionCandidate } from './isAutomationSessionCandidate';

const eligibleMetadata = {
    flavor: 'claude',
    claudeSessionId: 'claude-session-1',
    claudeTranscriptPath: '/tmp/claude-session-1.jsonl',
};

describe('isAutomationSessionCandidate', () => {
    it('accepts an ordinary user-facing resumable Session', () => {
        expect(isAutomationSessionCandidate({ metadata: eligibleMetadata }, {})).toBe(true);
    });

    it('rejects a hidden system Session even when its Agent resume metadata is otherwise eligible', () => {
        expect(isAutomationSessionCandidate({
            metadata: {
                ...eligibleMetadata,
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        }, {})).toBe(false);
    });

    it('rejects a visible Session that cannot actually resume for Automation execution', () => {
        expect(isAutomationSessionCandidate({
            metadata: { flavor: 'claude' },
        }, {})).toBe(false);
    });
});
