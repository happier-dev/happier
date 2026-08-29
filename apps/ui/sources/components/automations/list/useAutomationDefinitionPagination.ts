import * as React from 'react';

import {
    useActiveServerAccountScope,
    useAutomationDefinitionNextCursor,
} from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { sync } from '@/sync/sync';

type PageRequestState = Readonly<{
    scopeKey: string;
    cursor: string;
    status: 'loading' | 'error';
}> | null;

/**
 * Presentation state for the one store-owned Automation definition cursor.
 * The cursor and exact-CAS append stay in the sync/store owners; this hook only
 * prevents duplicate scroll requests and exposes retry state to list hosts.
 */
export function useAutomationDefinitionPagination() {
    const accountScope = useActiveServerAccountScope();
    const scopeKey = accountScope ? serverAccountScopeKeySuffix(accountScope) : 'unscoped';
    const nextCursor = useAutomationDefinitionNextCursor();
    const [request, setRequest] = React.useState<PageRequestState>(null);
    const requestRef = React.useRef<PageRequestState>(null);
    const currentScopeRef = React.useRef(scopeKey);
    currentScopeRef.current = scopeKey;

    const requestPage = React.useCallback(() => {
        const cursor = nextCursor;
        if (!cursor) return;
        if (
            requestRef.current?.scopeKey === scopeKey
            && requestRef.current.cursor === cursor
            && requestRef.current.status === 'loading'
        ) return;

        const loadingRequest = { scopeKey, cursor, status: 'loading' as const };
        requestRef.current = loadingRequest;
        setRequest(loadingRequest);
        void sync.loadMoreAutomations(cursor).then(() => {
            if (
                currentScopeRef.current === scopeKey
                && requestRef.current === loadingRequest
            ) {
                requestRef.current = null;
                setRequest(null);
            }
        }).catch(() => {
            if (
                currentScopeRef.current === scopeKey
                && requestRef.current === loadingRequest
            ) {
                const failedRequest = { scopeKey, cursor, status: 'error' as const };
                requestRef.current = failedRequest;
                setRequest(failedRequest);
            }
        });
    }, [nextCursor, scopeKey]);

    const isCurrentRequest = request?.scopeKey === scopeKey
        && request.cursor === nextCursor;
    return {
        nextCursor,
        hasMore: nextCursor !== null,
        loadingMore: isCurrentRequest && request?.status === 'loading',
        loadMoreFailed: isCurrentRequest && request?.status === 'error',
        requestPage,
    } as const;
}
