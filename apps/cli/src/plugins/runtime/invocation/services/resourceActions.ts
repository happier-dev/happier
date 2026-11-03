import { PluginError, type Disposable, type JsonValue, type PluginInvocationCaller } from '@happier-dev/plugin-sdk';
import type { ActionExecuteResult } from '@happier-dev/plugin-sdk/actions';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import type { InvokeContributedAction, ContributedActionInvocationResult } from './actions';
import type { BindDynamicResourceActions } from './resources';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

function projectReadResult(result: ContributedActionInvocationResult): ActionExecuteResult {
    if (result.status === 'executed') return { ok: true, result: result.value };
    const details = {
        ...(result.actionHandlerInvocation ? { actionHandlerInvocation: result.actionHandlerInvocation } : {}),
        ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
        ...(result.data === undefined ? {} : { data: result.data }),
    };
    return { ok: false, errorCode: result.code, error: result.message,
        ...(Object.keys(details).length ? { details } : {}) };
}

/** One lifetime owner shared by Resource reads and original admitted-operation observers. */
export async function observeContributedActionRead(params: Readonly<{
    signal: AbortSignal;
    invalidate(): void;
    retire?(): void;
    isCurrent(): boolean | Promise<boolean>;
    invoke(observation: NonNullable<Parameters<InvokeContributedAction>[0]['readObservation']>, signal: AbortSignal): Promise<ContributedActionInvocationResult>;
}>): Promise<Disposable> {
    const controller = new AbortController();
    const signal = AbortSignal.any([params.signal, controller.signal]);
    let subscription: Disposable | null = null;
    let disposed = false;
    let cleanup: Promise<void> | undefined;
    const dispose = () => {
        if (disposed) return cleanup;
        disposed = true;
        signal.removeEventListener('abort', onAbort);
        if (!controller.signal.aborted) controller.abort();
        const current = subscription;
        subscription = null;
        try {
            const pending = current?.dispose();
            if (pending) cleanup = Promise.resolve(pending);
        } catch (error) {
            cleanup = Promise.reject<void>(error);
        }
        if (cleanup) void cleanup.catch(() => {});
        return cleanup;
    };
    // EventTarget must not receive a rejected cleanup promise as a listener result.
    const onAbort = () => { dispose(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const result = await params.invoke({
            retire() {
                if (signal.aborted) return;
                try {
                    if (params.retire) params.retire();
                    else params.invalidate();
                } finally { dispose(); }
            },
            invalidate() {
                void Promise.resolve().then(params.isCurrent).then(current => {
                    if (current && !signal.aborted) {
                        try { params.invalidate(); } catch { /* One observer cannot fail its producer. */ }
                    }
                    else dispose();
                }, () => { dispose(); });
            },
            accept(next) {
                if (signal.aborted) {
                    try {
                        const pending = next.dispose();
                        if (pending) cleanup = Promise.resolve(pending);
                    } catch (error) { cleanup = Promise.reject<void>(error); }
                    if (cleanup) void cleanup.catch(() => {});
                } else subscription = next;
            },
        }, signal);
        if (result.status !== 'executed') throw new PluginError({ code: result.code, message: result.message });
        if (ActionApprovalRequestCreatedResultSchema.safeParse(result.value).success) {
            throw new PluginError({ code: 'plugin_action_read_observation_approval_required', message: 'The read dependency requires approval', details: result.value });
        }
        if (!subscription) throw new PluginError({ code: 'plugin_action_read_observation_invalid', message: 'The read Action did not install its dependency observer' });
        return Object.freeze({ dispose });
    } catch (error) {
        try { await dispose(); } catch { /* Preserve the original admission failure after cleanup. */ }
        throw error;
    }
}

/** Resource calls share the contributed Action dispatcher; this adapter only binds lifetime and caller. */
export function createDynamicResourceActionBinding(params: Readonly<{
    binding: Parameters<BindDynamicResourceActions>[0];
    invoke: InvokeContributedAction;
    readCaller(): Extract<PluginInvocationCaller, { kind: 'plugin' }> | null;
}>): Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'> {
    const { binding } = params;
    // The Resource owner admits both forms through its exact Session-access
    // proof before issuing this binding. Launch input never selects authority.
    const sessionId = binding.context.kind === 'session' ? binding.context.sessionId
        : binding.context.kind === 'surface' && binding.context.target?.kind === 'session'
            ? binding.context.target.sessionId : undefined;
    const assertCurrent = async (signal: AbortSignal) => {
        if (signal.aborted || !await binding.isOccurrenceCurrent() || signal.aborted) {
            throw new PluginError({ code: 'plugin_resource_aborted', message: 'Resource Action demand is no longer current' });
        }
    };
    const invoke = async (
        action: Parameters<InvokeContributedAction>[0]['action'], input: JsonValue,
        signal: AbortSignal, readObservation?: Parameters<InvokeContributedAction>[0]['readObservation'],
    ) => {
        await assertCurrent(signal);
        const caller = params.readCaller();
        if (!caller || caller.occurrenceId !== binding.occurrenceId) {
            throw new PluginError({ code: 'plugin_action_caller_unavailable', message: 'Resource Action reads require their current owning plugin' });
        }
        const result = await params.invoke({ action, input, caller, surface: 'plugin', requiredReadOnly: true,
            ...(sessionId === undefined ? {} : { sessionId, resourceSessionId: sessionId }),
            ...(readObservation ? { readObservation } : {}), signal });
        await assertCurrent(signal);
        return result;
    };
    return Object.freeze({
        async readAction(action, input, options) {
            const signal = options?.signal ? AbortSignal.any([binding.signal, options.signal]) : binding.signal;
            return projectReadResult(await invoke(action, input, signal));
        },
        async observeAction(action, input, invalidate, options) {
            return await observeContributedActionRead({
                signal: options?.signal ? AbortSignal.any([binding.signal, options.signal]) : binding.signal,
                invalidate, isCurrent: binding.isOccurrenceCurrent, retire: binding.retireObservation,
                invoke: (observation, signal) => invoke(action, input, signal, observation),
            });
        },
    });
}
