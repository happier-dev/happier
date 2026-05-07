import { beforeEach, describe, expect, it } from 'vitest';

import {
    clearActiveViewingSessionId,
    getActiveViewingSessionActivationId,
    getActiveViewingSessionId,
    setActiveViewingSessionId,
} from './activeViewingSession';
import {
    beginSessionViewingActivation,
    holdManualUnreadForActivation,
    resetSessionManualUnreadHoldsForTests,
    shouldSuppressAutomaticMarkViewed,
} from './readState/sessionManualUnreadHold';

describe('activeViewingSession', () => {
    beforeEach(() => {
        resetSessionManualUnreadHoldsForTests();
        clearActiveViewingSessionId('session-1');
        clearActiveViewingSessionId('session-2');
    });

    it('does not let a stale cleanup clear a newer activation for the same session id', () => {
        setActiveViewingSessionId('session-1', 101);
        setActiveViewingSessionId('session-1', 202);

        clearActiveViewingSessionId('session-1');

        expect(getActiveViewingSessionId()).toBe('session-1');
        expect(getActiveViewingSessionActivationId()).toBe(202);

        clearActiveViewingSessionId('session-1');

        expect(getActiveViewingSessionId()).toBeNull();
        expect(getActiveViewingSessionActivationId()).toBeNull();
    });

    it('restores an older same-session activation when the newer activation clears first', () => {
        const olderActivationId = beginSessionViewingActivation('session-1');
        const newerActivationId = beginSessionViewingActivation('session-1');
        setActiveViewingSessionId('session-1', olderActivationId);
        setActiveViewingSessionId('session-1', newerActivationId);

        clearActiveViewingSessionId('session-1', newerActivationId);

        expect(getActiveViewingSessionId()).toBe('session-1');
        expect(getActiveViewingSessionActivationId()).toBe(olderActivationId);

        holdManualUnreadForActivation({
            sessionId: 'session-1',
            sessionSeq: 7,
            activationId: getActiveViewingSessionActivationId(),
        });
        expect(shouldSuppressAutomaticMarkViewed({
            sessionId: 'session-1',
            sessionSeq: 7,
            activationId: olderActivationId,
        })).toBe(true);
    });
});
