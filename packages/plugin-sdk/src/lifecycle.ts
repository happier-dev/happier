export interface Disposable {
    dispose(): void | Promise<void>;
}

/**
 * Cancellation for one host call.
 *
 * The signal is honoured for the WHOLE in-flight window, not only when the call
 * is admitted: aborting it retires whatever the host is still holding for the
 * request — a confirmation dialog is dismissed — and the call rejects with a
 * typed host error instead of settling. An outward effect the host already
 * completed stays settled, so a late abort never invites a blind retry of a
 * mutation that already ran.
 */
export type PluginCancellationOptions = Readonly<{
    signal?: AbortSignal;
}>;
