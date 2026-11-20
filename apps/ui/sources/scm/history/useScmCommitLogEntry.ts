import type { ScmLogEntry } from '@happier-dev/protocol/scm';
import * as React from 'react';

import { searchWorkspaceCommits } from '@/scm/search/searchWorkspaceCommits';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type ScmCommitLogEntryState =
    | Readonly<{ status: 'loading'; entry: null }>
    | Readonly<{ status: 'ready'; entry: ScmLogEntry }>
    /** The commit's identity could not be read (offline, not found, an older daemon's recent page without it). */
    | Readonly<{ status: 'unavailable'; entry: null }>;

const LOADING: ScmCommitLogEntryState = { status: 'loading', entry: null };
const UNAVAILABLE: ScmCommitLogEntryState = { status: 'unavailable', entry: null };

function sameCommit(entry: ScmLogEntry, sha: string): boolean {
    const wanted = sha.toLowerCase();
    const full = entry.sha.toLowerCase();
    return full === wanted || full.startsWith(wanted) || wanted.startsWith(full);
}

/**
 * A commit's identity — subject, message, author, time, short SHA — for the Details header, read
 * through the one bounded commit query owner (`searchWorkspaceCommits`, SHA-prefix match). A commit
 * is immutable, so it is read once per scope and SHA. When it cannot be read the header keeps the
 * SHA it was opened with; the diff never waits on this.
 */
export function useScmCommitLogEntry(scope: WorkspaceScopeBase | null, sha: string): ScmCommitLogEntryState {
    const [state, setState] = React.useState<ScmCommitLogEntryState>(LOADING);
    const serverId = scope?.serverId ?? null;
    const machineId = scope?.machineId ?? null;
    const rootPath = scope?.rootPath ?? null;
    const workspace = scope?.workspace;

    React.useEffect(() => {
        const trimmedSha = sha.trim();
        if (!serverId || !machineId || !rootPath || !trimmedSha) {
            setState(UNAVAILABLE);
            return;
        }
        const controller = new AbortController();
        setState(LOADING);
        void searchWorkspaceCommits({
            scope: { serverId, machineId, rootPath, workspace },
            query: trimmedSha,
            limit: 5,
            signal: controller.signal,
        }).then((outcome) => {
            if (controller.signal.aborted) return;
            const entry = outcome.status === 'unavailable'
                ? null
                : outcome.entries.find((candidate) => sameCommit(candidate, trimmedSha)) ?? null;
            setState(entry ? { status: 'ready', entry } : UNAVAILABLE);
        }, () => {
            if (!controller.signal.aborted) setState(UNAVAILABLE);
        });
        return () => controller.abort();
    }, [machineId, rootPath, serverId, sha, workspace]);

    return state;
}
