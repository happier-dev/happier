import { describe, expect, it } from 'vitest';

import { sessionNeedsLiveTranscript } from './sessionRealtimeVisibility';

describe('sessionNeedsLiveTranscript', () => {
    it('activates for visible, explicit, and voice-tracked sessions', () => {
        expect(sessionNeedsLiveTranscript({ sessionId: 's1', isVisible: true }).reasons).toContain('visible');
        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            explicitTranscriptConsumerSessionIds: ['s1'],
        }).reasons).toContain('explicitTranscriptConsumer');
        expect(sessionNeedsLiveTranscript({
            sessionId: 's1',
            voiceTrackedSessionIds: ['s1'],
        }).reasons).toContain('voiceTracked');
    });

    it('matches only bounded SCM scopes', () => {
        const unrelated = sessionNeedsLiveTranscript({
            sessionId: 's1',
            sessionScmScope: { canonicalProjectKey: 'project-a' },
            scmMountedScopes: [{ canonicalProjectKey: 'project-b', needsMutationTranscript: true }],
        });
        const sameProject = sessionNeedsLiveTranscript({
            sessionId: 's1',
            sessionScmScope: { canonicalProjectKey: 'project-a' },
            scmMountedScopes: [{ canonicalProjectKey: 'project-a', needsMutationTranscript: true }],
        });

        expect(unrelated.active).toBe(false);
        expect(sameProject.reasons).toContain('scmSameProjectScope');
    });
});
