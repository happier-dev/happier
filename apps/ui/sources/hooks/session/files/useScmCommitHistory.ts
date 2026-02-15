import * as React from 'react';

import type { ScmLogEntry } from '@happier-dev/protocol';

import { sessionScmLogList } from '@/sync/ops';

export function useScmCommitHistory(input: {
    sessionId: string;
    readLogEnabled: boolean;
    sessionPath: string | null;
}) {
    const { sessionId, readLogEnabled } = input;
    const [historyEntries, setHistoryEntries] = React.useState<ScmLogEntry[]>([]);
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const [historySkip, setHistorySkip] = React.useState(0);
    const [historyHasMore, setHistoryHasMore] = React.useState(false);
    const legacySkipIgnoredRef = React.useRef(false);

    const historyEntriesRef = React.useRef(historyEntries);
    React.useEffect(() => {
        historyEntriesRef.current = historyEntries;
    }, [historyEntries]);

    const loadCommitHistory = React.useCallback(async (opts?: { reset?: boolean }) => {
        if (!readLogEnabled) {
            setHistoryEntries([]);
            setHistorySkip(0);
            setHistoryHasMore(false);
            setHistoryLoading(false);
            legacySkipIgnoredRef.current = false;
            return;
        }

        // Guard against concurrent pagination (e.g. repeated taps).
        if (historyLoading) {
            return;
        }

        setHistoryLoading(true);
        try {
            const skip = opts?.reset ? 0 : historySkip;
            const pageSize = 20;
            const legacyPagination = legacySkipIgnoredRef.current && !opts?.reset;
            const requestSkip = legacyPagination ? 0 : skip;
            const requestLimit = legacyPagination ? (skip + pageSize) : pageSize;

            const response = await sessionScmLogList(sessionId, {
                limit: requestLimit,
                skip: requestSkip,
            });
            if (response.success) {
                const incoming = response.entries ?? [];
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
                } else {
                    if (uniqueIncoming.length > 0) {
                        setHistoryEntries((prev) => [...prev, ...uniqueIncoming]);
                        setHistorySkip(skip + uniqueIncoming.length);
                        setHistoryHasMore(incoming.length >= requestLimit);
                    } else {
                        // Legacy daemons may ignore `skip` and always return the first page.
                        // Fall back to skip=0 and expand the limit so the user can still load more commits.
                        if (!legacyPagination && incoming.length > 0 && historyHasMore) {
                            legacySkipIgnoredRef.current = true;
                            const legacyLimit = skip + pageSize;
                            const legacyResponse = await sessionScmLogList(sessionId, {
                                limit: legacyLimit,
                                skip: 0,
                            });
                            if (legacyResponse.success) {
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
                            } else {
                                setHistoryHasMore(false);
                            }
                        } else {
                            setHistoryHasMore(false);
                        }
                    }
                }
            } else {
                if (opts?.reset) {
                    setHistoryEntries([]);
                    setHistorySkip(0);
                }
                setHistoryHasMore(false);
            }
        } finally {
            setHistoryLoading(false);
        }
    }, [historyLoading, historySkip, readLogEnabled, sessionId]);

    return {
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    };
}
