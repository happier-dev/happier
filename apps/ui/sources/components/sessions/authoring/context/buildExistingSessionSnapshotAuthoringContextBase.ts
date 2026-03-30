import {
    buildExistingSessionAuthoringSnapshot,
    type ExistingSessionAuthoringSnapshotSession,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/sessionAuthoringSnapshot';

export type ExistingSessionSnapshotAuthoringContextBase = Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    snapshot: SessionAuthoringSnapshot;
}>;

export function buildExistingSessionSnapshotAuthoringContextBase(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    sessionDekBase64?: string | null;
}>): ExistingSessionSnapshotAuthoringContextBase {
    return {
        session: params.session,
        snapshot: buildExistingSessionAuthoringSnapshot({
            session: params.session,
            sessionDekBase64: params.sessionDekBase64,
        }),
    };
}
