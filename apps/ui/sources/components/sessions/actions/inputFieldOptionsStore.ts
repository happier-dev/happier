import { getActionSpec, type ActionExecutorContext, type PublicActionResultById } from '@happier-dev/protocol';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { ActionFieldOption } from './ActionInputFields';

export type InputFieldOptionsState = Readonly<{
    options: readonly ActionFieldOption[];
    status: 'loading' | 'ready' | 'failed';
    errorCode?: string;
}>;
export const EMPTY_INPUT_OPTIONS: readonly ActionFieldOption[] = Object.freeze([]);
export const INPUT_OPTIONS_LOADING: InputFieldOptionsState = Object.freeze({ options: EMPTY_INPUT_OPTIONS, status: 'loading' });
export type InputOptionsRead = Readonly<{
    key: string;
    input: Record<string, unknown>;
    context: Omit<ActionExecutorContext, 'surface' | 'signal'>;
}>;
type ReadEntry = {
    state: InputFieldOptionsState;
    controller: AbortController;
    listeners: Set<() => void>;
    refreshKey?: string;
};

// Card paint and its transcript height projection share the same demanded read.
// The last subscriber releases both the projection and its pending request.
const reads = new Map<string, ReadEntry>();

function load(read: InputOptionsRead, entry: ReadEntry): void {
    const controller = entry.controller;
    void callWorkflowAction({
        actionId: 'action.options.resolve', input: read.input, context: read.context, signal: controller.signal,
        parseResult: (value) => getActionSpec('action.options.resolve').outputSchema!.parse(value) as PublicActionResultById['action.options.resolve'],
    }).then((result) => {
        if (controller.signal.aborted) return;
        const options = JSON.stringify(entry.state.options) === JSON.stringify(result.options)
            ? entry.state.options : result.options;
        entry.state = { status: 'ready', options };
        entry.listeners.forEach((listener) => listener());
    }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        entry.state = { status: 'failed', options: entry.state.options,
            errorCode: error instanceof WorkflowActionError ? error.rawCode ?? 'action_failed' : 'action_failed' };
        entry.listeners.forEach((listener) => listener());
    });
}

export function readInputFieldOptionsState(key: string): InputFieldOptionsState {
    return reads.get(key)?.state ?? INPUT_OPTIONS_LOADING;
}

export function subscribeInputFieldOptions(read: InputOptionsRead, listener: () => void, refreshKey?: string): () => void {
    let entry = reads.get(read.key);
    if (!entry) {
        entry = { state: INPUT_OPTIONS_LOADING, controller: new AbortController(), listeners: new Set(), refreshKey };
        reads.set(read.key, entry);
        load(read, entry);
    }
    entry.listeners.add(listener);
    const subscribedEntry = entry;
    return () => {
        subscribedEntry.listeners.delete(listener);
        if (subscribedEntry.listeners.size === 0) {
            subscribedEntry.controller.abort();
            reads.delete(read.key);
        }
    };
}

export function retryInputFieldOptions(read: InputOptionsRead): void {
    const entry = reads.get(read.key);
    if (!entry) return;
    entry.controller.abort();
    entry.controller = new AbortController();
    entry.state = { status: entry.state.options.length ? 'ready' : 'loading', options: entry.state.options };
    entry.listeners.forEach((listener) => listener());
    load(read, entry);
}

export function refreshInputFieldOptions(read: InputOptionsRead, refreshKey: string | undefined): void {
    const entry = reads.get(read.key);
    if (!entry || entry.refreshKey === refreshKey) return;
    entry.refreshKey = refreshKey;
    retryInputFieldOptions(read);
}
