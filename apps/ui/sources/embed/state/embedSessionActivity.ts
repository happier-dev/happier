import type { EmbedStateV1 } from '@happier-dev/protocol/embed';
import type { SessionAwarenessOperationalPrimaryV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';

import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

export type EmbedActivity = NonNullable<EmbedStateV1['activity']>;

/** The host badge's three states, read from the session awareness owner's operational primary. */
export function projectEmbedActivity(primary: SessionAwarenessOperationalPrimaryV1): EmbedActivity {
    switch (primary) {
        case 'failed':
        case 'permission_required':
        case 'action_required':
        // A blocking usage limit holds the Session until someone (or recovery) acts.
        case 'usage_limited':
            return 'needs_attention';
        case 'working':
            return 'working';
        case 'ready':
        case 'pending_input':
        case 'none':
            return 'idle';
    }
}

/**
 * Watches the embedded session in the store and reports its activity once per change. Updates to
 * other sessions, or to this session that leave its activity unchanged, emit nothing.
 */
export function watchEmbedSessionActivity(input: Readonly<{
    sessionId: string;
    onActivity: (activity: EmbedActivity) => void;
    now?: () => number;
}>): () => void {
    const now = input.now ?? Date.now;
    let last: EmbedActivity | null = null;
    const report = (session: Session | undefined) => {
        if (!session) return;
        const activity = projectEmbedActivity(projectUiSessionAwareness(session, now()).operational.primary);
        if (activity === last) return;
        last = activity;
        input.onActivity(activity);
    };
    report(storage.getState().sessions[input.sessionId]);
    return storage.subscribe(state => report(state.sessions[input.sessionId]), { sessions: [input.sessionId] });
}
