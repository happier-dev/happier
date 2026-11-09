import * as React from 'react';

import type { ScmLogEntry, ScmLogListResponse } from '@happier-dev/protocol/scm';

import { SCM_HISTORY_PAGE_SIZE } from './historyPresentation';

export function usePagedScmCommitHistory(input: Readonly<{
    enabled: boolean;
    historyIdentity: string;
    loadPage: (request: Readonly<{ limit: number; skip: number }>) => Promise<Pick<ScmLogListResponse, 'success' | 'entries'>>;
}>) {
    const { enabled, loadPage, historyIdentity } = input;
    const [historyEntries, setHistoryEntries] = React.useState<ScmLogEntry[]>([]);
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const [historyError, setHistoryError] = React.useState(false);
    const [historySkip, setHistorySkip] = React.useState(0);
    const [historyHasMore, setHistoryHasMore] = React.useState(false);
    const [loadedIdentity, setLoadedIdentity] = React.useState(historyIdentity);
    const currentIdentityRef = React.useRef(historyIdentity);
    currentIdentityRef.current = historyIdentity;
    const legacySkipIgnoredRef = React.useRef(false);
    if (loadedIdentity !== historyIdentity) {
        setLoadedIdentity(historyIdentity);
        setHistoryEntries([]);
        setHistorySkip(0);
        setHistoryHasMore(false);
        setHistoryLoading(false);
        setHistoryError(false);
        legacySkipIgnoredRef.current = false;
    }

    const historyEntriesRef = React.useRef(historyEntries);
    React.useEffect(() => {
        historyEntriesRef.current = historyEntries;
    }, [historyEntries]);

    const loadCommitHistory = React.useCallback(async (opts?: { reset?: boolean }) => {
        if (!enabled) {
            setHistoryEntries([]);
            setHistorySkip(0);
            setHistoryHasMore(false);
            setHistoryLoading(false);
            setHistoryError(false);
            legacySkipIgnoredRef.current = false;
            return;
        }
        if (historyLoading) return;

        setHistoryLoading(true);
        setHistoryError(false);
        try {
            const skip = opts?.reset ? 0 : historySkip;
            const pageSize = SCM_HISTORY_PAGE_SIZE;
            const legacyPagination = legacySkipIgnoredRef.current && !opts?.reset;
            const requestSkip = legacyPagination ? 0 : skip;
            const previousEntries = historyEntriesRef.current;
            const refreshDepth = opts?.reset ? Math.max(pageSize, previousEntries.length) : pageSize;
            let requestLimit = opts?.reset ? Math.min(500, refreshDepth) : legacyPagination ? (skip + pageSize) : pageSize;

            let response = await loadPage({ limit: requestLimit, skip: requestSkip });
            if (currentIdentityRef.current !== historyIdentity) return;
            if (!response.success) {
                setHistoryError(true);
                setHistoryHasMore(false);
                return;
            }

            let incoming = response.entries ?? [];
            if (opts?.reset && previousEntries.length > 0) {
                const previousHeadIndex = incoming.findIndex((entry) => entry.sha === previousEntries[0]?.sha);
                const targetDepth = refreshDepth + Math.max(0, previousHeadIndex);
                let hasMore = incoming.length >= requestLimit;
                while (incoming.length < targetDepth && hasMore) {
                    requestLimit = Math.min(500, Math.max(pageSize, targetDepth - incoming.length));
                    response = await loadPage({ limit: requestLimit, skip: incoming.length });
                    if (currentIdentityRef.current !== historyIdentity) return;
                    if (!response.success) {
                        setHistoryError(true);
                        setHistoryHasMore(false);
                        return;
                    }
                    const page = response.entries ?? [];
                    const existingShas = new Set(incoming.map((entry) => entry.sha));
                    const additions = page.filter((entry) => !existingShas.has(entry.sha));
                    if (page.length > 0 && additions.length === 0) {
                        // Daemons that ignore skip use the existing limit-expansion contract.
                        requestLimit = Math.min(500, targetDepth);
                        response = await loadPage({ limit: requestLimit, skip: 0 });
                        if (currentIdentityRef.current !== historyIdentity) return;
                        if (!response.success || (response.entries?.length ?? 0) <= incoming.length) {
                            setHistoryError(!response.success);
                            setHistoryHasMore(false);
                            return;
                        }
                        incoming = response.entries ?? [];
                        hasMore = incoming.length >= requestLimit;
                    } else {
                        incoming = [...incoming, ...additions];
                        hasMore = page.length >= requestLimit;
                    }
                }
                legacySkipIgnoredRef.current = false;
                setHistoryEntries(incoming);
                setHistorySkip(incoming.length);
                setHistoryHasMore(hasMore);
                return;
            }
            const previous = opts?.reset ? [] : historyEntriesRef.current;
            const previousShas = new Set(previous.map((entry) => entry.sha));
            const uniqueIncoming: ScmLogEntry[] = [];
            for (const entry of incoming) {
                if (previousShas.has(entry.sha)) continue;
                previousShas.add(entry.sha);
                uniqueIncoming.push(entry);
            }

            if (opts?.reset) {
                legacySkipIgnoredRef.current = false;
                setHistoryEntries(incoming);
                setHistorySkip(incoming.length);
                setHistoryHasMore(incoming.length >= requestLimit);
                return;
            }

            if (uniqueIncoming.length > 0) {
                setHistoryEntries((prev) => [...prev, ...uniqueIncoming]);
                setHistorySkip(skip + uniqueIncoming.length);
                setHistoryHasMore(incoming.length >= requestLimit);
                return;
            }

            if (!legacyPagination && incoming.length > 0 && historyHasMore) {
                legacySkipIgnoredRef.current = true;
                const legacyLimit = skip + pageSize;
                const legacyResponse = await loadPage({ limit: legacyLimit, skip: 0 });
                if (currentIdentityRef.current !== historyIdentity) return;
                if (!legacyResponse.success) {
                    setHistoryError(true);
                    setHistoryHasMore(false);
                    return;
                }
                const legacyEntries = legacyResponse.entries ?? [];
                const legacyShas = new Set<string>();
                const uniqueLegacy: ScmLogEntry[] = [];
                for (const entry of legacyEntries) {
                    if (legacyShas.has(entry.sha)) continue;
                    legacyShas.add(entry.sha);
                    uniqueLegacy.push(entry);
                }
                if (uniqueLegacy.length > previous.length) {
                    setHistoryEntries(uniqueLegacy);
                    setHistorySkip(uniqueLegacy.length);
                    setHistoryHasMore(uniqueLegacy.length >= legacyLimit);
                } else {
                    setHistoryHasMore(false);
                }
                return;
            }

            setHistoryHasMore(false);
        } catch {
            if (currentIdentityRef.current !== historyIdentity) return;
            setHistoryError(true);
            setHistoryHasMore(false);
        } finally {
            if (currentIdentityRef.current === historyIdentity) setHistoryLoading(false);
        }
    }, [historyIdentity, enabled, historyHasMore, historyLoading, historySkip, loadPage]);

    return {
        historyIdentity,
        historyEntries,
        historyLoading,
        historyError,
        historyHasMore,
        loadCommitHistory,
    };
}
