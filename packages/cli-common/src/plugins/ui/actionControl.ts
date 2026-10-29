import {
    PluginUiActionControlEventV1Schema,
    PluginUiActionControlPreparationV1Schema,
    PluginUiActionControlPresentationV1Schema,
    type PluginUiActionControlPreparationV1,
    type PluginUiActionControlRequestV1,
} from '@happier-dev/protocol/plugins/ui/client';
import { isPluginError, PluginError } from '../errors.js';
import type { Disposable } from '../registration/contracts.js';
import type { PluginUiActionControlExecutionV1, PluginUiActionControlPresentationV1 } from '@happier-dev/protocol/plugins/ui/client';

export type PluginUiActionControlPresentation = Readonly<PluginUiActionControlPresentationV1>;
export type PluginUiActionControlPreparation = Readonly<PluginUiActionControlPreparationV1>;
export type PluginUiActionControlExecution = Readonly<PluginUiActionControlExecutionV1>;
export type PluginUiActionControlController = Readonly<{
    prepare(options: Readonly<{ signal: AbortSignal }>): PluginUiActionControlPreparation | null | Promise<PluginUiActionControlPreparation | null>;
    onSettled(execution: PluginUiActionControlExecution): void;
}>;
export type PluginUiActionControl = Disposable & Readonly<{
    update(presentation: PluginUiActionControlPresentation): Promise<void>;
}>;

/** Shared callback custody for the direct and framed physical carriers. */
export async function createPluginUiActionControlBinding(params: Readonly<{
    controller: PluginUiActionControlController;
    signal?: AbortSignal;
    lifetimeSignal: AbortSignal;
    subscribe(
        listener: (event: unknown, subscriptionId: string) => void,
        onRetire: () => void,
        signal: AbortSignal,
    ): Promise<Disposable & Readonly<{ subscriptionId: string }>>;
    request(request: PluginUiActionControlRequestV1, signal: AbortSignal): Promise<unknown>;
}>): Promise<PluginUiActionControl> {
    const lifetime = new AbortController();
    let subscription: (Disposable & Readonly<{ subscriptionId: string }>) | undefined;
    let pending: { requestId: string; abort: AbortController; settled: boolean } | undefined;
    const signals = [params.signal, params.lifetimeSignal];
    const retire = () => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        pending?.abort.abort();
        for (const signal of signals) signal?.removeEventListener('abort', dispose);
    };
    const dispose = () => {
        retire();
        return subscription?.dispose();
    };
    for (const signal of signals) signal?.addEventListener('abort', dispose, { once: true });
    if (signals.some(signal => signal?.aborted)) retire();
    const assertActive = () => {
        if (lifetime.signal.aborted) throw new PluginError({ code: 'aborted' });
    };
    const settle = (execution: PluginUiActionControlExecution) => {
        // A controller's presenter cannot restart preparation or corrupt custody.
        try { params.controller.onSettled(execution); } catch { /* Isolate author callback failure. */ }
    };
    try {
        assertActive();
        subscription = await params.subscribe((value, subscriptionId) => {
            if (lifetime.signal.aborted) return;
            const parsed = PluginUiActionControlEventV1Schema.safeParse(value);
            if (!parsed.success) {
                void dispose();
                throw new PluginError({ code: 'invalid_payload' });
            }
            const event = parsed.data;
            if (event.kind === 'settled') {
                if (!pending || pending.requestId !== event.requestId || pending.settled) return;
                pending.settled = true;
                pending.abort.abort();
                settle(event.execution);
                return;
            }
            if (pending?.requestId === event.requestId) return;
            pending?.abort.abort();
            const preparation = { requestId: event.requestId, abort: new AbortController(), settled: false };
            pending = preparation;
            const current = () => !lifetime.signal.aborted && pending === preparation && !preparation.settled;
            void (async () => {
                let input: PluginUiActionControlPreparationV1 | null;
                try {
                    const prepared = await params.controller.prepare({ signal: preparation.abort.signal });
                    input = prepared === null ? null : PluginUiActionControlPreparationV1Schema.parse(prepared);
                } catch (error) {
                    if (!current()) return;
                    preparation.settled = true;
                    preparation.abort.abort();
                    // Null relinquishes this exact host preparation. Its acknowledgement
                    // cannot turn local validation failure into an automatic retry.
                    void params.request({ kind: 'prepared', subscriptionId, requestId: event.requestId, preparation: null }, lifetime.signal).catch(() => undefined);
                    settle({ ok: false, errorCode: 'preparation_failed', error: error instanceof Error ? error.message || 'preparation_failed' : 'preparation_failed' });
                    return;
                }
                if (!current()) return;
                try {
                    await params.request({ kind: 'prepared', subscriptionId, requestId: event.requestId, preparation: input }, lifetime.signal);
                } catch (error) {
                    if (!current()) return;
                    preparation.settled = true;
                    preparation.abort.abort();
                    settle({ ok: false, errorCode: isPluginError(error) ? error.code : 'action_outcome_unknown',
                        error: error instanceof Error ? error.message || 'action_outcome_unknown' : 'action_outcome_unknown' });
                }
            })();
        }, retire, lifetime.signal);
        if (lifetime.signal.aborted) { await subscription.dispose(); assertActive(); }
        const established = subscription;
        return Object.freeze({
            dispose,
            update: async (presentation: PluginUiActionControlPresentation) => {
                assertActive();
                const parsed = PluginUiActionControlPresentationV1Schema.safeParse(presentation);
                if (!parsed.success) throw new PluginError({ code: 'invalid_payload' });
                await params.request({ kind: 'update', subscriptionId: established.subscriptionId, presentation: parsed.data }, lifetime.signal);
            },
        });
    } catch (error) {
        retire();
        throw error;
    }
}
