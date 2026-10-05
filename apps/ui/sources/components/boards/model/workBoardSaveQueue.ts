import {
    applyWorkBoardIntentV1,
    WorkBoardMutationErrorV1,
    WorkBoardWidgetMutationErrorV1,
    type WorkBoardIntentV1,
    type WorkBoardsV1,
    type WorkBoardArtifactPortV1,
} from '@happier-dev/protocol';

/**
 * The optimistic queue of a Home's Board Artifacts.
 *
 * Every edit is a `WorkBoardIntentV1` from the protocol owner. It shows at once — the displayed
 * boards are the last acknowledged boards with the pending intents replayed on top — and is then
 * written through the shared Board Artifact port, which replays the same intent against the
 * current Artifact winner. A refusal drops the intent, so
 * the last acknowledged board shows again, and leaves an actionable failure with Retry.
 *
 * Writes run one at a time, in order: each replays against the result of the one before.
 */

export type WorkBoardSaveFailureReason = 'invalidValue' | 'not_found' | 'unavailable';

export type WorkBoardSaveFailure = Readonly<{
    intent: WorkBoardIntentV1;
    reason: WorkBoardSaveFailureReason;
}>;

export type WorkBoardSaveState = Readonly<{
    pending: readonly WorkBoardIntentV1[];
    failure: WorkBoardSaveFailure | null;
}>;

export type WorkBoardSaveOutcome = Readonly<{ status: 'applied'; boards: WorkBoardsV1 }>
    | Readonly<{ status: 'refused' | 'unknown'; code: string }>;

const INITIAL_STATE: WorkBoardSaveState = Object.freeze({ pending: Object.freeze([]), failure: null });

/** The boards to show: the acknowledged boards with every pending edit replayed by the protocol owner. */
export function projectDisplayedWorkBoards(acknowledged: WorkBoardsV1, pending: readonly WorkBoardIntentV1[]): WorkBoardsV1 {
    let boards = acknowledged;
    for (const intent of pending) {
        try {
            const result = applyWorkBoardIntentV1(boards, intent);
            if (result.status === 'applied') boards = result.boards;
        } catch (error) {
            // An acknowledgement may publish before its pending intent retires, or a
            // concurrent edit may invalidate it. Keep the acknowledged projection;
            // the actual writer still decides and exposes the pending edit's outcome.
            if (!(error instanceof WorkBoardWidgetMutationErrorV1)) throw error;
        }
    }
    return boards;
}

export type WorkBoardSaveQueue = Readonly<{
    getState(): WorkBoardSaveState;
    subscribe(listener: () => void): () => void;
    dispatch(intent: WorkBoardIntentV1): Promise<WorkBoardSaveOutcome>;
    /** Replays the failed edit. */
    retry(): Promise<WorkBoardSaveOutcome | null>;
    dismissFailure(): void;
    /** Forgets pending edits and the failure (another Account or Home took over). */
    reset(): void;
}>;

export function createWorkBoardSaveQueue(deps: Readonly<{ port: Pick<WorkBoardArtifactPortV1, 'read' | 'apply'> }>): WorkBoardSaveQueue {
    let state = INITIAL_STATE;
    let generation = 0;
    let tail: Promise<void> = Promise.resolve();
    const listeners = new Set<() => void>();
    const setState = (next: WorkBoardSaveState) => {
        state = next;
        for (const listener of listeners) listener();
    };

    const write = async (intent: WorkBoardIntentV1, writeGeneration: number): Promise<WorkBoardSaveOutcome> => {
        let failure: WorkBoardSaveFailure | null = null;
        let outcome: WorkBoardSaveOutcome;
        try {
            if (writeGeneration !== generation) return { status: 'refused', code: 'board_scope_retired' };
            const boards = await deps.port.apply(intent);
            outcome = { status: 'applied', boards };
        } catch (error) {
            failure = { intent, reason: error instanceof WorkBoardWidgetMutationErrorV1 ? 'invalidValue' : error instanceof WorkBoardMutationErrorV1
                ? error.code === 'board_not_found' ? 'not_found'
                    : error.code === 'board_scope_retired' ? 'unavailable' : 'invalidValue' : 'unavailable' };
            outcome = error instanceof WorkBoardWidgetMutationErrorV1 || error instanceof WorkBoardMutationErrorV1 && error.code !== 'board_scope_retired'
                ? { status: 'refused', code: error.code }
                : { status: 'unknown', code: error instanceof WorkBoardMutationErrorV1 ? error.code : 'board_write_unknown' };
        }
        // Retirement hides the projection, never rewrites an already-dispatched outcome.
        if (writeGeneration !== generation) return outcome;
        setState({
            pending: state.pending.filter((candidate) => candidate !== intent),
            failure: failure ?? state.failure,
        });
        return outcome;
    };

    const dispatch = (intent: WorkBoardIntentV1): Promise<WorkBoardSaveOutcome> => {
        const writeGeneration = generation;
        setState({ pending: [...state.pending, intent], failure: null });
        const result = tail.then(() => write(intent, writeGeneration));
        tail = result.then(() => {});
        return result;
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        dispatch,
        retry() {
            const failed = state.failure;
            return failed ? dispatch(failed.intent) : Promise.resolve(null);
        },
        dismissFailure() {
            if (state.failure) setState({ ...state, failure: null });
        },
        reset() {
            generation += 1;
            setState(INITIAL_STATE);
        },
    };
}
