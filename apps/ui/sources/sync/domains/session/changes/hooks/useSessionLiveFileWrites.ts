import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { deriveLiveFileWrites, type LiveFileWrite } from '../derivation/deriveLiveFileWrites';
import { useFileWriteSessionRunningSnapshots, type FileWriteSessionRunningSnapshot } from './fileWriteSessionSnapshots';
import { projectUiSessionRuntimeAwareness, readSessionRuntimePresentationFreshnessExpirations } from '@/sync/domains/session/attention/runtimePresentation';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';

const EMPTY: ReadonlyMap<string, LiveFileWrite> = Object.freeze(new Map<string, LiveFileWrite>());

function equalWrite(left: LiveFileWrite | undefined, right: LiveFileWrite): boolean {
    return left?.toolCallId === right.toolCallId && left.sessionId === right.sessionId
        && left.kind === right.kind && left.startedAt === right.startedAt
        && left.region?.startLine === right.region?.startLine && left.region?.endLine === right.region?.endLine
        && left.anchorText === right.anchorText;
}

/** Both session and workspace consumers read the same canonical effective activity answer. */
export function useLiveFileWritesFromSessionSnapshots(snapshots: readonly FileWriteSessionRunningSnapshot[], workspaceRoot: string | null, includeSidechains = false): ReadonlyMap<string, LiveFileWrite> {
    const projected = React.useRef(new Map<string, Readonly<{
        runningCalls: FileWriteSessionRunningSnapshot['runningCalls']; root: string | null; includeSidechains: boolean; writes: ReadonlyMap<string, LiveFileWrite>;
    }>>());
    const readNextRefreshAtMs = React.useCallback((nowMs: number) => {
        let next: number | null = null;
        for (const snapshot of snapshots) {
            for (const expiry of readSessionRuntimePresentationFreshnessExpirations(snapshot.session, nowMs)) {
                if (expiry > nowMs && (next === null || expiry < next)) next = expiry;
            }
        }
        return next;
    }, [snapshots]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, snapshots.length > 0);
    const next = React.useMemo(() => {
        const writes = new Map<string, LiveFileWrite>();
        for (const snapshot of snapshots) {
            // Protocol's owner defeats stale thinking with terminal turns, offline state and crashes.
            const activity = projectUiSessionRuntimeAwareness({ ...snapshot.session, nowMs });
            if (!activity.live || (!activity.working && !activity.backgroundActive)) continue;
            const root = workspaceRoot ?? snapshot.workspaceRoot;
            let projection = projected.current.get(snapshot.session.id);
            if (!projection || projection.runningCalls !== snapshot.runningCalls || projection.root !== root || projection.includeSidechains !== includeSidechains) {
                projection = { runningCalls: snapshot.runningCalls, root, includeSidechains, writes: deriveLiveFileWrites(snapshot.runningCalls, { workspaceRoot: root, sessionId: snapshot.session.id, includeSidechains }) };
                projected.current.set(snapshot.session.id, projection);
            }
            for (const [path, write] of projection.writes) {
                if ((writes.get(path)?.startedAt ?? -Infinity) <= write.startedAt) writes.set(path, write);
            }
        }
        const attached = new Set(snapshots.map(snapshot => snapshot.session.id));
        for (const id of projected.current.keys()) if (!attached.has(id)) projected.current.delete(id);
        return writes;
    }, [snapshots, workspaceRoot, nowMs, includeSidechains]);
    const retained = React.useRef(EMPTY);
    if (retained.current.size !== next.size || [...next].some(([path, write]) => !equalWrite(retained.current.get(path), write))) {
        retained.current = next.size === 0 ? EMPTY : Object.freeze(new Map([...next].map(([path, write]) => [path,
            equalWrite(retained.current.get(path), write) ? retained.current.get(path)! : write,
        ])));
    }
    return retained.current;
}

/** Current-session activity for Track; descendant sidechains are not this session's current file. */
export function useSessionLiveFileWrites(address: SessionAddress | null, workspaceRoot: string | null = null): ReadonlyMap<string, LiveFileWrite> {
    return useLiveFileWritesFromSessionSnapshots(useFileWriteSessionRunningSnapshots({ address }), workspaceRoot);
}
