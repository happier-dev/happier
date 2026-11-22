import type { ScmComparison, ScmFileViewedStateV1 } from './projections.js';

export type ScmFileViewedFile = Readonly<{
    state: ScmFileViewedStateV1 | null;
    pending: boolean;
    errorCode: string | null;
}>;
export type ScmFileViewedSnapshot = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    headOid: string | null;
    errorCode: string | null;
}>;
/** The host's transient PR map. Rows observe their path, never a whole-map snapshot. */
export type ScmFileViewedSource = Readonly<{
    getFile(path: string): ScmFileViewedFile;
    subscribeFile(path: string, listener: () => void): () => void;
    getSnapshot(): ScmFileViewedSnapshot;
    subscribeStatus(listener: () => void): () => void;
    subscribeChanges(listener: (path: string) => void): () => void;
    getViewedPaths(): ReadonlySet<string>;
    /** Snapshot token for the opt-in Viewed filter. Acknowledgements that leave membership intact keep this token. */
    getViewedPathsRevision?(): number;
    /** Current-head files whose forge Viewed mark was dismissed by changed content. */
    getChangedSinceViewedCount?(): number;
    setViewed(path: string, viewed: boolean): Promise<boolean>;
    refresh(): Promise<void>;
}>;
/** Same-realm host request; Account and Action authority stay with the mounted host. */
export type ScmFileViewedRequest = Readonly<{
    /** Only source identity/currentness is needed; a plugin does not construct a diff inventory. */
    comparison: Pick<ScmComparison, 'source' | 'freshness' | 'endpoints'> | null;
    serverId: string | null;
    host: Readonly<{ sessionId: string; machineId?: never }> | Readonly<{ machineId: string; sessionId?: never }> | null;
    active?: boolean;
    refreshToken?: unknown;
    enabled?: boolean;
}>;

export const UNKNOWN_SCM_FILE_VIEWED: ScmFileViewedFile = Object.freeze({ state: null, pending: false, errorCode: null });
export const IDLE_SCM_FILE_VIEWED: ScmFileViewedSnapshot = Object.freeze({ status: 'idle', headOid: null, errorCode: null });
