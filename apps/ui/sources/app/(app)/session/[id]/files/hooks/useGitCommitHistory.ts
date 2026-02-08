import * as React from 'react';

import type { GitLogEntry } from '@happier-dev/protocol';

import { sessionGitLogList } from '@/sync/ops';

export function useGitCommitHistory(input: {
    sessionId: string;
    gitWriteEnabled: boolean;
    sessionPath: string | null;
}) {
    const { sessionId, gitWriteEnabled, sessionPath } = input;
    const [historyEntries, setHistoryEntries] = React.useState<GitLogEntry[]>([]);
    const [historyLoading, setHistoryLoading] = React.useState(false);
    const [historySkip, setHistorySkip] = React.useState(0);
    const [historyHasMore, setHistoryHasMore] = React.useState(false);

    const loadCommitHistory = React.useCallback(async (opts?: { reset?: boolean }) => {
        if (!gitWriteEnabled || !sessionPath) {
            setHistoryEntries([]);
            setHistorySkip(0);
            setHistoryHasMore(false);
            return;
        }

        setHistoryLoading(true);
        try {
            const skip = opts?.reset ? 0 : historySkip;
            const response = await sessionGitLogList(sessionId, {
                cwd: sessionPath,
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
    }, [gitWriteEnabled, historySkip, sessionId, sessionPath]);

    return {
        historyEntries,
        historyLoading,
        historyHasMore,
        loadCommitHistory,
    };
}
