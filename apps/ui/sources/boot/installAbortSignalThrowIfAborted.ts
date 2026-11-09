import { throwIfAborted } from '@/utils/runtime/abortSignals';

/** React Native's AbortSignal lacks this standard API used by UI cancellation. */
export function installAbortSignalThrowIfAborted(): void {
    if (typeof AbortSignal.prototype.throwIfAborted === 'function') return;

    Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
        configurable: true,
        writable: true,
        value(this: AbortSignal) {
            throwIfAborted(this);
        },
    });
}
