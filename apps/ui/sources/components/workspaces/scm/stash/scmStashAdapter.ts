import type {
    ScmStashApplyResponse,
    ScmStashDropResponse,
    ScmStashListResponse,
    ScmStashPopResponse,
    ScmStashShowResponse,
} from '@happier-dev/protocol/scm';

/** `onDispatched` fires when the Action really reaches the Machine, after any in-place confirmation. */
export type ScmStashWriteCall = Readonly<{ onDispatched: () => void }>;

export type ScmStashDetailsAdapter = Readonly<{
    list: () => Promise<ScmStashListResponse>;
    show: (stashRef: string) => Promise<ScmStashShowResponse>;
    pop: (stashRef: string, call?: ScmStashWriteCall) => Promise<ScmStashPopResponse>;
    drop: (stashRef: string, call?: ScmStashWriteCall) => Promise<ScmStashDropResponse>;
    /** Puts the stash's changes back and keeps the stash (Restore also removes it). */
    apply: (stashRef: string, call?: ScmStashWriteCall) => Promise<ScmStashApplyResponse>;
}>;
