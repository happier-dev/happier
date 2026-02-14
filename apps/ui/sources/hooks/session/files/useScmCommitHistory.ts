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
            return;
        }

        // Guard against concurrent pagination (e.g. repeated taps).
        if (historyLoading) {
            return;
        }

        setHistoryLoading(true);
        try {
            const skip = opts?.reset ? 0 : historySkip;
            const limit = 20;
            const response = await sessionScmLogList(sessionId, {
                limit,
                skip,
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
                    setHistoryEntries(incoming);
                    setHistorySkip(incoming.length);
                    setHistoryHasMore(incoming.length >= limit);
                } else {
                    if (uniqueIncoming.length > 0) {
                        setHistoryEntries((prev) => [...prev, ...uniqueIncoming]);
                        setHistorySkip(skip + incoming.length);
                        setHistoryHasMore(incoming.length >= limit);
                    } else {
                        // Legacy daemons may ignore `skip` and always return the first page.
                        // If pagination makes no progress, stop offering "load more" instead of looping forever.
                        setHistoryHasMore(false);
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
