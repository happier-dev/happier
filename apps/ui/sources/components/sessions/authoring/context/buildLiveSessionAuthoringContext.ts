import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';

import type { LiveSessionAuthoringContext } from './sessionAuthoringContext';
import { buildExistingSessionSnapshotAuthoringContextBase } from './buildExistingSessionSnapshotAuthoringContextBase';

export function buildLiveSessionAuthoringContext(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    sessionDekBase64?: string | null;
}>): LiveSessionAuthoringContext {
    return {
        kind: 'liveSession',
        ...buildExistingSessionSnapshotAuthoringContextBase({
            session: params.session,
            sessionDekBase64: params.sessionDekBase64,
        }),
    };
}
