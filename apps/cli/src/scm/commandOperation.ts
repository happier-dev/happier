import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScmCommandInput } from './runtime';

const operation = new AsyncLocalStorage<Readonly<{ signal?: AbortSignal }>>();

/** Git phases share their containing operation's cancellation, without a shorter deadline. */
export function runWithScmCommandOperation<T>(signal: AbortSignal | undefined, run: () => T): T {
    const parent = operation.getStore()?.signal;
    return operation.run({ signal: combineSignals(parent, signal) }, run);
}

function combineSignals(parent: AbortSignal | undefined, signal: AbortSignal | undefined): AbortSignal | undefined {
    return parent && signal && parent !== signal ? AbortSignal.any([parent, signal]) : parent ?? signal;
}

export function resolveScmCommandOperationInput(input: ScmCommandInput): ScmCommandInput {
    const current = operation.getStore();
    return current ? { ...input, timeoutMs: undefined, signal: combineSignals(current.signal, input.signal) } : input;
}
