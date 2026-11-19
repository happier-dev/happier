import type { ScmComparison, ScmFileViewedReadResultV1 } from '@happier-dev/protocol/scm/comparison';
import { UNKNOWN_SCM_FILE_VIEWED, IDLE_SCM_FILE_VIEWED, type ScmFileViewedFile, type ScmFileViewedSnapshot } from '@happier-dev/plugin-sdk/scm';
export { UNKNOWN_SCM_FILE_VIEWED, IDLE_SCM_FILE_VIEWED } from '@happier-dev/plugin-sdk/scm';
export type { ScmFileViewedFile, ScmFileViewedSnapshot, ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';

/** Source file facts describe the live head; a pending read reserves its slot until it can decide. */
export function isScmFileViewedCurrentHead(comparison: Pick<ScmComparison, 'freshness' | 'endpoints'>, snapshot: ScmFileViewedSnapshot): boolean {
    return comparison.freshness !== 'stale' && (snapshot.headOid === null || comparison.endpoints.after === snapshot.headOid);
}

/** Mounted source facts, keyed by path. Local Keep keys never enter this owner. */
export function createScmFileViewedState() {
    const files = new Map<string, ScmFileViewedFile>();
    const viewedPaths = new Set<string>();
    const fileListeners = new Map<string, Set<() => void>>();
    const changeListeners = new Set<(path: string) => void>();
    const statusListeners = new Set<() => void>();
    let snapshot = IDLE_SCM_FILE_VIEWED;
    let viewedPathsRevision = 0;
    const getFile = (path: string) => files.get(path) ?? UNKNOWN_SCM_FILE_VIEWED;
    const setStatus = (status: ScmFileViewedSnapshot['status'], headOid = snapshot.headOid, errorCode: string | null = null) => {
        if (snapshot.status === status && snapshot.headOid === headOid && snapshot.errorCode === errorCode) return;
        snapshot = { status, headOid, errorCode };
        for (const listener of statusListeners) listener();
    };
    const applyFile = (path: string, next: ScmFileViewedFile) => {
        const previous = getFile(path);
        if (previous.state === next.state && previous.pending === next.pending && previous.errorCode === next.errorCode) return;
        if (next === UNKNOWN_SCM_FILE_VIEWED) files.delete(path); else files.set(path, next);
        if ((previous.state === 'viewed') !== (next.state === 'viewed')) {
            if (next.state === 'viewed') viewedPaths.add(path); else viewedPaths.delete(path);
            viewedPathsRevision += 1;
        }
        if (previous.state !== next.state) for (const listener of changeListeners) listener(path);
        for (const listener of fileListeners.get(path) ?? []) listener();
    };
    return {
        getFile,
        getSnapshot: () => snapshot,
        getViewedPaths: (): ReadonlySet<string> => viewedPaths,
        getViewedPathsRevision: () => viewedPathsRevision,
        subscribeFile: (path: string, listener: () => void) => {
            let listeners = fileListeners.get(path);
            if (!listeners) fileListeners.set(path, listeners = new Set());
            listeners.add(listener);
            return () => { listeners.delete(listener); if (listeners.size === 0) fileListeners.delete(path); };
        },
        subscribeStatus: (listener: () => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
        subscribeChanges: (listener: (path: string) => void) => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
        beginRead: () => { if (snapshot.status !== 'ready') setStatus('loading'); },
        fail: (errorCode: string) => setStatus('error', snapshot.headOid, errorCode),
        applyRead: (result: Extract<ScmFileViewedReadResultV1, { kind: 'ready' }>) => {
            const present = new Set<string>();
            for (const file of result.files) {
                present.add(file.path);
                applyFile(file.path, { state: file.state, pending: false, errorCode: null });
            }
            for (const path of files.keys()) if (!present.has(path)) applyFile(path, UNKNOWN_SCM_FILE_VIEWED);
            setStatus('ready', result.headOid);
        },
        applyFile,
        retire: () => {
            if (viewedPaths.size > 0) viewedPathsRevision += 1;
            files.clear(); viewedPaths.clear(); fileListeners.clear(); changeListeners.clear(); statusListeners.clear();
            snapshot = IDLE_SCM_FILE_VIEWED;
        },
    };
}
