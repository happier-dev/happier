import * as React from 'react';

import { buildSnapshotSignature } from '@/scm/statusSync/projectState';
import { scmSnapshotEntriesAreComplete } from '@/scm/core/snapshotMappers';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import {
    ScmStatusEntriesWindow,
    type ScmStatusEntriesWindowState,
} from './scmStatusEntriesWindow';

export type UseScmStatusEntriesWindowResult = Readonly<{
    state: ScmStatusEntriesWindowState;
    expandDirectory: (directoryPath: string) => void;
    collapseDirectory: (directoryPath: string) => void;
    loadMoreExpanded: (directoryPath: string) => void;
    loadMoreTopLevel: () => void;
}>;

/**
 * React binding for the Files surface's bounded entries window.
 *
 * Summary/detail doctrine: this hook is mounted by the open surface leaf; it
 * stays idle (zero RPCs) while the snapshot carries the complete entry set
 * (legacy daemons, fallback shapes) and only loads entry rows on demand when
 * the poll delivered a summary. Freshness has exactly one owner: the snapshot
 * signature/`fetchedAt` advance re-drives `refresh()`; there is no TTL, no
 * second poll interval.
 */
export function useScmStatusEntriesWindow(input: {
    sessionId: string;
    snapshot: ScmWorkingSnapshot | null;
}): UseScmStatusEntriesWindowResult {
    const { sessionId, snapshot } = input;

    const windowRef = React.useRef<ScmStatusEntriesWindow | null>(null);
    const windowSessionRef = React.useRef<string | null>(null);
    if (windowRef.current === null || windowSessionRef.current !== sessionId) {
        windowRef.current?.dispose?.();
        windowRef.current = new ScmStatusEntriesWindow({ sessionId });
        windowSessionRef.current = sessionId;
    }
    const window = windowRef.current;

    React.useEffect(() => {
        return () => {
            windowRef.current?.dispose?.();
            windowRef.current = null;
            windowSessionRef.current = null;
        };
    }, []);

    const enabled = Boolean(
        snapshot
        && snapshot.repo.isRepo
        && !scmSnapshotEntriesAreComplete(snapshot)
    );
    const signature = React.useMemo(() => (
        snapshot && snapshot.repo.isRepo ? buildSnapshotSignature(snapshot) : null
    ), [snapshot]);
    const lastRefreshedSignatureRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!enabled || !signature) return;
        if (lastRefreshedSignatureRef.current === signature) return;
        lastRefreshedSignatureRef.current = signature;
        void window.refresh();
    }, [enabled, signature, window]);

    const state = React.useSyncExternalStore(
        React.useCallback((listener: () => void) => window.subscribe(listener), [window]),
        () => window.getState(),
        () => window.getState(),
    );

    const expandDirectory = React.useCallback((directoryPath: string) => {
        void window.expandDirectory(directoryPath);
    }, [window]);
    const collapseDirectory = React.useCallback((directoryPath: string) => {
        window.collapseDirectory(directoryPath);
    }, [window]);
    const loadMoreExpanded = React.useCallback((directoryPath: string) => {
        void window.loadMoreExpanded(directoryPath);
    }, [window]);
    const loadMoreTopLevel = React.useCallback(() => {
        void window.loadMoreTopLevel();
    }, [window]);

    return { state, expandDirectory, collapseDirectory, loadMoreExpanded, loadMoreTopLevel };
}
