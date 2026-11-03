import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { DispatchPluginSurfaceActionInput } from './pluginSurfaceActionDispatch';

/** One observer lifetime for Resource, ordinary Action and admitted-operation reads. */
export async function observePluginSurfaceActionRead(input: Readonly<{
    signal: AbortSignal;
    /** Caller currentness; a retiring target must still invalidate a live caller. */
    isCurrent(): boolean;
    invalidate(): void;
    retire?(): void;
    invoke(observation: NonNullable<DispatchPluginSurfaceActionInput['readObservation']>, signal: AbortSignal): Promise<PluginUiJsonValueV1>;
}>): Promise<Disposable> {
    const controller = new AbortController();
    const cancellation = mergeAbortSignals([input.signal, controller.signal]);
    let subscription: Disposable | undefined;
    let disposed = false;
    let cleanup: Promise<void> | undefined;
    const dispose = () => {
        if (disposed) return cleanup;
        disposed = true;
        cancellation.signal.removeEventListener('abort', onAbort);
        controller.abort();
        try {
            const pending = subscription?.dispose();
            if (pending) cleanup = Promise.resolve(pending).finally(() => cancellation.dispose());
            else cancellation.dispose();
        } catch (error) {
            cancellation.dispose();
            cleanup = Promise.reject(error);
        }
        // Abort listeners have no awaiting caller; explicit disposal retains the original cleanup.
        if (cleanup) void cleanup.catch(() => {});
        return cleanup;
    };
    const onAbort = () => { void dispose(); };
    cancellation.signal.addEventListener('abort', onAbort, { once: true });
    try {
        const result = await input.invoke({
            invalidate() {
                if (!disposed && input.isCurrent() && !cancellation.signal.aborted) {
                    try { input.invalidate(); } catch { /* One observer cannot fail its producer. */ }
                } else dispose();
            },
            retire() {
                if (disposed || !input.isCurrent() || cancellation.signal.aborted) { void dispose(); return; }
                void dispose();
                try { (input.retire ?? input.invalidate)(); } catch { /* Local retirement remains authoritative. */ }
            },
            accept(next) {
                if (disposed || cancellation.signal.aborted) {
                    const pending = next.dispose();
                    if (pending) void pending.catch(() => {});
                } else subscription = next;
            },
        }, cancellation.signal);
        if (cancellation.signal.aborted || !input.isCurrent()) throw new PluginError({ code: 'plugin_action_generation_retired' });
        if (ActionApprovalRequestCreatedResultSchema.safeParse(result).success) {
            throw new PluginError({ code: 'plugin_action_read_observation_approval_required',
                message: 'The read dependency requires approval', details: result });
        }
        if (!subscription || disposed) throw new PluginError({ code: 'plugin_action_read_observation_invalid' });
        return Object.freeze({ dispose });
    } catch (error) {
        try { await dispose(); } catch { /* Preserve the original admission failure after cleanup. */ }
        throw error;
    }
}
