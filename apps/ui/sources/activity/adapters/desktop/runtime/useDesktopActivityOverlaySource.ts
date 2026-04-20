import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useConnectedServiceQuotaSummaries, type ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { storage } from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';

export type DesktopActivityOverlaySource = Readonly<{
    isDataReady: boolean;
    sessionsById: Readonly<Record<string, Session>>;
    sessionListRenderablesById: Readonly<Record<string, SessionListRenderableSession>>;
    sessionListIndexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    quotaSummaries: ReadonlyArray<ConnectedServiceQuotaSummary>;
}>;

const EMPTY_INDEX_BY_SERVER_ID: DesktopActivityOverlaySource['sessionListIndexByServerId'] = {};
const EMPTY_RENDERABLES_BY_ID: DesktopActivityOverlaySource['sessionListRenderablesById'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ConcurrentSessionListCacheByServerId = {};

export function useDesktopActivityOverlaySource(): DesktopActivityOverlaySource {
    const { summaries } = useConnectedServiceQuotaSummaries();

    const source = storage(useShallow((state) => ({
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRenderablesById: state.sessionListRenderables ?? EMPTY_RENDERABLES_BY_ID,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
    })));

    return React.useMemo(() => ({
        ...source,
        quotaSummaries: summaries,
    }), [source, summaries]);
}
