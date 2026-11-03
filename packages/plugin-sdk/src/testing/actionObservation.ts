import type { PluginActionReadInvalidation } from '../actions/contracts.js';
import type { Disposable } from '../lifecycle.js';

/** Owns installed read subscriptions until caller or testkit retirement. */
export function createActionObservationScope() {
    const subscriptions = new Set<Disposable>();
    const retirementErrors: unknown[] = [];
    return {
        track(subscription: Disposable, signal: AbortSignal, invalidate: PluginActionReadInvalidation): Disposable {
            let disposal: Promise<void> | undefined;
            const managed = Object.freeze({
                dispose(): Promise<void> {
                    disposal ??= Promise.resolve().then(async () => {
                        signal.removeEventListener('abort', retire);
                        try { await subscription.dispose(); }
                        finally { subscriptions.delete(managed); }
                    });
                    return disposal;
                },
            });
            function retire(): void {
                try { invalidate.retire(); }
                catch (error) { retirementErrors.push(error); }
                void managed.dispose().catch(error => { retirementErrors.push(error); });
            }
            subscriptions.add(managed);
            if (signal.aborted) retire();
            else signal.addEventListener('abort', retire, { once: true });
            return managed;
        },
        async dispose(): Promise<void> {
            const settled = await Promise.allSettled([...subscriptions].map(subscription => subscription.dispose()));
            const errors = [...retirementErrors.splice(0), ...settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])];
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Plugin read observation cleanup failed');
        },
    };
}
