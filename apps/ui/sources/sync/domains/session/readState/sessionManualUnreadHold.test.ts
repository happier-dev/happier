import { beforeEach, describe, expect, it } from 'vitest';

import {
    beginSessionViewingActivation,
    clearManualUnreadHold,
    endSessionViewingActivation,
    getCurrentSessionViewingActivationId,
    holdManualUnreadForActivation,
    resetSessionManualUnreadHoldsForTests,
    shouldSuppressAutomaticMarkViewed,
} from './sessionManualUnreadHold';

describe('sessionManualUnreadHold', () => {
    beforeEach(() => {
        resetSessionManualUnreadHoldsForTests();
    });

    it('suppresses automatic mark-viewed only for the activation that created the hold', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');

        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: firstActivationId })).toBe(true);
        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId })).toBe(false);
    });

    it('tracks the current activation for the focused session', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');

        expect(firstActivationId).not.toBe(secondActivationId);
        expect(getCurrentSessionViewingActivationId('s1')).toBe(secondActivationId);
    });

    it('clears all holds for a session when activation id is omitted or null', () => {
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

    it('ends an activation, removes its hold, and leaves another activation current', () => {
        const firstActivationId = beginSessionViewingActivation('s1');
        const secondActivationId = beginSessionViewingActivation('s1');
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId });

        endSessionViewingActivation('s1', secondActivationId);

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: secondActivationId })).toBe(false);
        expect(getCurrentSessionViewingActivationId('s1')).toBe(firstActivationId);
    });

    it('does not hold when no activation is available', () => {
        holdManualUnreadForActivation({ sessionId: 's1', sessionSeq: 8, activationId: null });

        expect(shouldSuppressAutomaticMarkViewed({ sessionId: 's1', sessionSeq: 8, activationId: null })).toBe(false);
    });
});
