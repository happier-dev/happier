import {
    ScmFileViewedReadResultV1Schema, ScmFileViewedSetResultV1Schema,
    type ScmComparisonSource,
} from '@happier-dev/protocol/scm/comparison';
import { createScmFileViewedState, type ScmFileViewedSource } from '@/sync/domains/scm/fileViewed';

type FileViewedActions = NonNullable<Extract<ScmComparisonSource, { kind: 'pullRequest' }>['locator']['fileViewedActions']>;

function errorCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : 'result_unavailable';
}

/** One presented PR owns its reads and toggles; Action admission remains at the transport. */
export function createScmFileViewedOperations(params: Readonly<{
    actions: FileViewedActions;
    execute: (invocation: FileViewedActions['read'], signal: AbortSignal) => Promise<unknown>;
    shouldContinue?: () => boolean;
}>): ScmFileViewedSource & Readonly<{ refresh: (signal?: AbortSignal) => Promise<void>; retire: () => void }> {
    const state = createScmFileViewedState();
    const lifetime = new AbortController();
    let readController: AbortController | null = null;
    let pendingRead: Promise<void> | null = null;
    const current = () => !lifetime.signal.aborted && params.shouldContinue?.() !== false;
    const refresh = (signal?: AbortSignal): Promise<void> => {
        if (!current() || signal?.aborted) return Promise.resolve();
        if (pendingRead && !readController?.signal.aborted) return pendingRead;
        const controller = new AbortController();
        readController = controller;
        const abort = () => controller.abort();
        lifetime.signal.addEventListener('abort', abort, { once: true });
        signal?.addEventListener('abort', abort, { once: true });
        state.beginRead();
        const read = (async () => {
            try {
                const result = ScmFileViewedReadResultV1Schema.parse(await params.execute(params.actions.read, controller.signal));
                if (!current() || controller.signal.aborted) return;
                if (result.kind === 'ready') state.applyRead(result); else state.fail(result.failure.code);
            } catch (error) { if (current() && !controller.signal.aborted) state.fail(errorCode(error)); }
            finally {
                lifetime.signal.removeEventListener('abort', abort);
                signal?.removeEventListener('abort', abort);
                if (readController === controller) { pendingRead = null; readController = null; }
            }
        })();
        pendingRead = read;
        return read;
    };
    const setViewed = async (path: string, viewed: boolean): Promise<boolean> => {
        if (!current() || state.getSnapshot().status !== 'ready') return false;
        const previous = state.getFile(path);
        if (previous.state === null || previous.pending) return false;
        // A whole-map read started before this intent cannot replace its later acknowledgement.
        readController?.abort();
        state.applyFile(path, { ...previous, pending: true, errorCode: null });
        try {
            const base = params.actions.set.input;
            const result = ScmFileViewedSetResultV1Schema.parse(await params.execute({ ...params.actions.set,
                input: { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}), path, viewed },
            }, lifetime.signal));
            if (!current()) return false;
            if (result.kind === 'unavailable') {
                state.applyFile(path, { ...previous, pending: false, errorCode: result.failure.code });
                return false;
            }
            state.applyFile(path, { state: result.state, pending: false, errorCode: null });
            return true;
        } catch (error) {
            if (current()) state.applyFile(path, { ...previous, pending: false, errorCode: errorCode(error) });
            return false;
        }
    };
    return {
        getFile: state.getFile, subscribeFile: state.subscribeFile, getSnapshot: state.getSnapshot,
        subscribeStatus: state.subscribeStatus, subscribeChanges: state.subscribeChanges, getViewedPaths: state.getViewedPaths,
        refresh, setViewed,
        retire: () => { lifetime.abort(); state.retire(); },
    };
}
