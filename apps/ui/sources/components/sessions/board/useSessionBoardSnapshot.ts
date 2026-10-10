import * as React from 'react';

import { projectSessionBoard } from '@/sync/domains/session/board';
import { useSessionSystemRecordBinding } from '@/sync/domains/sessionSystemRecords/useSessionSystemRecordBinding';
import { observeSessionBoard, type SessionBoardBinding } from './observeSessionBoard';

export type SessionBoardSnapshotBinding = SessionBoardBinding & Readonly<{ refresh: () => void }>;
export type SessionBoardSnapshotInput = Readonly<{
    serverId: string | null;
    sessionId: string;
    boardFeatureEnabled: boolean;
    /** Direct Board hosts demand by default; Session shells publish actual surface demand. */
    demanded?: boolean;
}>;

const LOADING = Object.freeze({ status: 'ready' as const, snapshot: projectSessionBoard({
    layout: undefined, items: new Map(), capabilities: null, freshness: 'stale', reachability: 'unknown', loading: 'initial', incomplete: true,
}) });

/** The Board's single binding to exact-Home, Account-owned Session records. */
export function useSessionBoardSnapshot(input: SessionBoardSnapshotInput): SessionBoardSnapshotBinding {
    const observed = useSessionSystemRecordBinding<Extract<SessionBoardBinding, { status: 'ready' }>, 'board_feature_disabled'>({
        serverId: input.serverId,
        sessionId: input.sessionId,
        enabled: input.boardFeatureEnabled && input.demanded !== false,
        loading: LOADING,
        observe: observeSessionBoard,
    });
    const disabled = !input.boardFeatureEnabled;
    return React.useMemo(() => disabled
        ? { status: 'unavailable' as const, reason: 'board_feature_disabled' as const, refresh: observed.refresh }
        : observed, [disabled, observed]);
}
