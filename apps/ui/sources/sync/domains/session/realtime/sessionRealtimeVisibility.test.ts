import { describe, expect, it } from 'vitest';

import { sessionNeedsLiveTranscript, sessionScmMutationSignalWanted } from './sessionRealtimeVisibility';

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

    it('keeps the mounted SCM consumer session itself a live transcript consumer', () => {
        const sameSession = sessionNeedsLiveTranscript({
            sessionId: 's1',
            scmMountedScopes: [{ sessionId: 's1', canonicalProjectKey: 'project-a', needsMutationTranscript: true }],
        });

        expect(sameSession.reasons).toContain('scmSameSession');
        expect(sameSession.active).toBe(true);
    });

    it('does not promote hidden same-project sessions to full transcript consumers', () => {
        const hiddenSameProject = sessionNeedsLiveTranscript({
            sessionId: 's1',
            scmMountedScopes: [{ sessionId: 's2', canonicalProjectKey: 'project-a', needsMutationTranscript: true }],
        });

        expect(hiddenSameProject.active).toBe(false);
        expect(hiddenSameProject.reasons).toEqual([]);
    });
});

describe('sessionScmMutationSignalWanted', () => {
    it('wants the signal for hidden sessions in the same canonical project scope', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: { canonicalProjectKey: 'project-a' },
            scmMountedScopes: [{ sessionId: 's2', canonicalProjectKey: 'project-a', needsMutationTranscript: true }],
        })).toBe(true);
    });

    it('wants the signal for the mounted consumer session itself', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: null,
            scmMountedScopes: [{ sessionId: 's1', canonicalProjectKey: 'project-a', needsMutationTranscript: true }],
        })).toBe(true);
    });

    it('does not want the signal outside the mounted project scope', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: { canonicalProjectKey: 'project-b' },
            scmMountedScopes: [{ sessionId: 's2', canonicalProjectKey: 'project-a', needsMutationTranscript: true }],
        })).toBe(false);
    });

    it('ignores scopes without needsMutationTranscript', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: { canonicalProjectKey: 'project-a' },
            scmMountedScopes: [{ sessionId: 's2', canonicalProjectKey: 'project-a' }],
        })).toBe(false);
    });

    it('does not want the signal without mounted scopes', () => {
        expect(sessionScmMutationSignalWanted({
            sessionId: 's1',
            sessionScmScope: { canonicalProjectKey: 'project-a' },
            scmMountedScopes: [],
        })).toBe(false);
    });
});
