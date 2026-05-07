import { beforeEach, describe, expect, it } from 'vitest';
import { clearActiveViewingSessionId, setActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';

import {
    beginSessionViewingActivation,
    clearManualUnreadHold,
    endSessionViewingActivation,
    holdManualUnreadForActivation,
    resetSessionManualUnreadHoldsForTests,
    shouldSuppressAutomaticMarkViewed,
} from './sessionManualUnreadHold';

describe('sessionManualUnreadHold', () => {
    beforeEach(() => {
        resetSessionManualUnreadHoldsForTests();
    });

    it('suppresses automatic mark-viewed for the activation that created the hold', () => {
        const activationId = beginSessionViewingActivation('s1');

        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId })).toBe(true);
    });

    it('does not suppress a different activation for the same session', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');

        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId })).toBe(false);
    });

    it('clears only the current active viewing hold when activation id is omitted', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId });
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId });
        setActiveViewingSessionId('s1', firstActivationId);

        try {
            clearManualUnreadHold({ sessionId: 's1' });

            expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId })).toBe(false);
            expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId })).toBe(true);
        } finally {
            clearActiveViewingSessionId('s1', firstActivationId);
        }
    });

    it('clears all holds for a session when activation id is explicitly null', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId });
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId });

        clearManualUnreadHold({ sessionId: 's1', activationId: null });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId })).toBe(false);
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId })).toBe(false);
    });

    it('clears only the requested activation hold', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId });
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId });

        clearManualUnreadHold({ sessionId: 's1', activationId: firstActivationId });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId })).toBe(false);
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId })).toBe(true);
    });

    it('ends an activation and removes its hold', () => {
        const activationId = beginSessionViewingActivation('s1');
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId });

        endSessionViewingActivation('s1', activationId);

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId })).toBe(false);
    });

    it('does not hold when no activation is available', () => {
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: null });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: null })).toBe(false);
    });
});
