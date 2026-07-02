import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { useSetting } from '@/sync/domains/state/storage';
import { getSessionStatus, type SessionStatus } from '@/utils/sessions/sessionUtils';

type SessionRowStatusSource = Session | SessionListRenderableSession;

export function useSessionListRenderableStatus(session: SessionRowStatusSource): SessionStatus {
    const sessionListWorkingStatusAnimatedTextEnabled = useSetting('sessionListWorkingStatusAnimatedTextEnabled');
    return getSessionStatus(session, Date.now(), {
        workingTextMode: sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated',
    });
}
