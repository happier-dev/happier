import type { PluginUiMountedActionReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { PluginUiActionControlPreparation, PluginUiActionControlExecution } from './actionControl.js';
import { mergeAbortSignals } from '../http/service.js';

type BindingLifecycle<Value, Preparation> = Readonly<{
    /** Accessible identity independent of the visible caption. */
    accessibilityLabel?: string;
    /** Explicit person Stop; withdrawing the control alone does not cancel admitted work. */
    signal?: AbortSignal;
    /** Null cancels this gesture. Async preparation stays within the mounted host lifetime. */
    prepare(value: Value, options: Readonly<{ signal: AbortSignal }>): Preparation | null | Promise<Preparation | null>;
    /** Original host envelope. Return applied true/false or a domain/envelope settlement for the existing notice. */
    onSettled(execution: PluginUiActionControlExecution): unknown;
}>;

/** A host-owned inline commit. Preparation derives input; it never receives an executor. */
export type PluginUiActionBinding<Value, Key extends string = string, Action = PluginUiMountedActionReferenceV1> =
    | (BindingLifecycle<Value, PluginUiActionControlPreparation> & Readonly<{
        action: Action;
        actions?: never;
    }>)
    | (BindingLifecycle<Value, PluginUiActionControlPreparation & Readonly<{ action: Key }>> & Readonly<{
        action?: never;
        actions: Readonly<Record<Key, Action>>;
    }>);

/** Host invocation lifecycle; the supplied executor retains all authority/admission decisions. */
export async function invokePluginUiActionBinding<Value>(binding: PluginUiActionBinding<Value>, value: Value,
    options: Readonly<{
        signal: AbortSignal;
        preparationSignal?: AbortSignal;
        available: boolean;
        isCurrent(): boolean;
        captureCurrentBinding(): () => boolean;
        execute(action: PluginUiMountedActionReferenceV1, preparation: PluginUiActionControlPreparation, signal: AbortSignal): Promise<PluginUiActionControlExecution>;
    }>): Promise<unknown> {
    const settle = async (execution: PluginUiActionControlExecution) => await binding.onSettled(execution) ?? execution;
    if (!options.isCurrent() || options.available === false) {
        return settle({ ok: false, errorCode: 'stale_surface', error: 'stale_surface' });
    }
    const isCurrentBinding = options.captureCurrentBinding();
    // Capture declared choices with this gesture before async preparation.
    const declaredActions = binding.actions === undefined ? undefined : { ...binding.actions };
    const declaredAction = binding.action;
    const executionLifetime = mergeAbortSignals([options.signal, binding.signal]);
    const executionSignal = executionLifetime.signal ?? options.signal;
    const preparationLifetime = mergeAbortSignals([executionSignal, options.preparationSignal]);
    const preparationSignal = preparationLifetime.signal ?? executionSignal;
    let execution: PluginUiActionControlExecution | null;
    let preparing = true;
    const prepareAndExecute = async (): Promise<PluginUiActionControlExecution | null> => {
        if (preparationSignal.aborted) return { ok: false, errorCode: 'aborted', error: 'aborted' };
        const preparation = await binding.prepare(value, { signal: preparationSignal });
        if (preparationSignal.aborted) return { ok: false, errorCode: 'aborted', error: 'aborted' };
        if (preparation === null) return null;
        if (!options.isCurrent() || !isCurrentBinding()) return { ok: false, errorCode: 'stale_surface', error: 'stale_surface' };
        const key = 'action' in preparation ? preparation.action : undefined;
        const action = declaredActions === undefined ? declaredAction
            : typeof key === 'string' && Object.hasOwn(declaredActions, key) ? declaredActions[key] : undefined;
        if (action === undefined) return { ok: false, errorCode: 'invalid_action', error: 'invalid_action' };
        preparing = false;
        return options.execute(action, preparation, executionSignal);
    };
    try {
        execution = await prepareAndExecute();
    } catch (error) {
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        const errorCode = (preparing ? preparationSignal : executionSignal).aborted ? 'aborted'
            : typeof code === 'string' ? code : preparing ? 'preparation_failed' : 'action_outcome_unknown';
        execution = { ok: false, errorCode, error: errorCode };
    } finally {
        preparationLifetime.dispose();
        executionLifetime.dispose();
    }
    return execution === null ? { status: 'refused', reason: 'cancelled' } : settle(execution);
}
