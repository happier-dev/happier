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

    const loadCommitHistory = React.useCallback(async (opts?: { reset?: boolean }) => {
        if (!readLogEnabled) {
            setHistoryEntries([]);
            setHistorySkip(0);
            setHistoryHasMore(false);
            return;
        }

        setHistoryLoading(true);
        try {
            const skip = opts?.reset ? 0 : historySkip;
            const response = await sessionScmLogList(sessionId, {
                limit: 20,
                skip,
            });
            if (response.success) {
                const incoming = response.entries ?? [];
                if (opts?.reset) {
                    setHistoryEntries(incoming);
                } else {
                    setHistoryEntries((previous) => {
                        const next = [...previous];
                        for (const entry of incoming) {
                            if (!next.some((value) => value.sha === entry.sha)) {
                                next.push(entry);
                            }
                        }
                        return next;
                    });
                }
                setHistorySkip(skip + incoming.length);
                setHistoryHasMore(incoming.length >= 20);
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
    }, [historySkip, readLogEnabled, sessionId]);

    return {
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    };
}
