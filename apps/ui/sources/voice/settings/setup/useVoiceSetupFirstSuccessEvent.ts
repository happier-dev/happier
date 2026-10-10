import * as React from 'react';

import type { VoiceMarkEvent } from '@/components/voice/presence/resolveVoiceMarkPose';

const FIRST_SUCCESS_EVENT: VoiceMarkEvent = Object.freeze({ kind: 'gather', id: 'voice-setup:first-success' });

/**
 * The first-success gather (VE-01, lab SD): the setup planet's dots gather once when the first genuine
 * turn completes setup here — the fact turns true while this surface is open, after the person tried.
 * A completion that was already true, or that history hydration reveals without a try, is not an event.
 */
export function useVoiceSetupFirstSuccessEvent(firstTurnComplete: boolean, live: boolean): VoiceMarkEvent | null {
    const tried = React.useRef(live);
    const previous = React.useRef(firstTurnComplete);
    const [event, setEvent] = React.useState<VoiceMarkEvent | null>(null);
    React.useEffect(() => {
        if (live) tried.current = true;
    }, [live]);
    React.useEffect(() => {
        if (firstTurnComplete && !previous.current && tried.current) setEvent(FIRST_SUCCESS_EVENT);
        previous.current = firstTurnComplete;
    }, [firstTurnComplete]);
    return event;
}
