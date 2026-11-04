import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import type { ScreenCaptureStartInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { startNativeCapture, subscribeNativeCapture, type NativeCaptureSnapshot,
    type NativeCaptureSessionTarget, type NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { isCaptureWindowLabel, listenDesktopWindowActionResult, type DesktopWindowActionResult } from '@/utils/platform/desktopWindowActionBridge';

type StartInput = ReturnType<typeof ScreenCaptureStartInputSchema.parse>;
type Delivered = Readonly<{ captureRef: string; messageRef: string }>
    | Readonly<{ captureRef: string; imageNumber: number; waiting: boolean }>;

function failure(errorCode: string): ActionExecuteFailure { return { ok: false, errorCode, error: errorCode }; }

export function resolveCaptureRequestTarget(input: Readonly<{ targetSession?: NativeCaptureSessionTarget }>,
    context: ActionExecutorContext): NativeCaptureSessionTarget | undefined {
    if (input.targetSession) return input.targetSession;
    return context.defaultSessionId && context.serverId && context.runtimeAccountId
        ? { serverId: context.serverId, accountId: context.runtimeAccountId, sessionId: context.defaultSessionId } : undefined;
}

/** An admitted agent capture follows its native operation and the person's existing bridge result. */
export async function executeInteractiveScreenCapture(input: StartInput, context: ActionExecutorContext,
    deliverFrontmost: (capture: NativeCaptureResult, target: NativeCaptureSessionTarget) => Promise<unknown>): Promise<unknown> {
    const targetSession = resolveCaptureRequestTarget(input, context);
    const nativeInput = { ...input, mode: input.mode === 'screenshot' ? 'still' : 'recording', targetSession } satisfies Parameters<typeof startNativeCapture>[0];
    if (context.surface === 'ui') return startNativeCapture(nativeInput);
    if (!targetSession) return failure('session_not_selected');
    if (input.mode === 'screenshot' && input.target?.kind === 'frontmost') {
        const snapshot = await startNativeCapture({ ...nativeInput, presentCaptureWindow: false });
        if (snapshot.status === 'completed') return deliverFrontmost(snapshot.result, targetSession);
        if (snapshot.status === 'failed' || snapshot.status === 'unavailable') return failure(snapshot.reason);
        return failure(snapshot.status === 'cancelled' ? 'cancelled' : 'operation_unavailable');
    }
    let operationRef: number | undefined;
    let captureRef: string | undefined;
    let latestSnapshot: NativeCaptureSnapshot | undefined;
    let resolveResult: (result: Delivered | ActionExecuteFailure) => void = () => {};
    const result = new Promise<Delivered | ActionExecuteFailure>(resolve => { resolveResult = resolve; });
    const onSnapshot = (snapshot: NativeCaptureSnapshot) => {
        latestSnapshot = snapshot;
        if (operationRef === undefined) return;
        if (snapshot.status === 'completed' && snapshot.operationRef === operationRef) captureRef = snapshot.result.captureRef;
        // Once selection completed, only this capture's delivery/discard settles the wait.
        if (captureRef) return;
        if (snapshot.status === 'cancelled') resolveResult(failure('cancelled'));
        if (snapshot.status === 'failed' || snapshot.status === 'unavailable') resolveResult(failure(snapshot.reason));
        if (snapshot.status === 'recording' && snapshot.operationRef === operationRef && snapshot.recording.phase === 'failed') {
            resolveResult(failure(snapshot.recording.error ?? 'native_failure'));
        }
    };
    const onWindowResult = (outcome: DesktopWindowActionResult) => {
        if (!isCaptureWindowLabel(outcome.windowLabel) || outcome.phase === 'admitted' || !captureRef) return;
        const details = outcome.details;
        const delivered = outcome.ok ? outcome.result : details && typeof details === 'object' && 'delivered' in details ? details.delivered : null;
        if (!delivered || typeof delivered !== 'object' || !('captureRef' in delivered) || delivered.captureRef !== captureRef) return;
        if ('messageRef' in delivered && typeof delivered.messageRef === 'string') {
            resolveResult({ captureRef, messageRef: delivered.messageRef });
        } else if ('imageNumber' in delivered && typeof delivered.imageNumber === 'number' && 'waiting' in delivered && typeof delivered.waiting === 'boolean') {
            resolveResult({ captureRef, imageNumber: delivered.imageNumber, waiting: delivered.waiting });
        } else if ('status' in delivered && delivered.status === 'discarded') resolveResult(failure('cancelled'));
    };
    const onAbort = () => resolveResult(failure('cancelled'));
    const stopState = await subscribeNativeCapture(onSnapshot);
    let stopResults: (() => void) | undefined;
    try {
        stopResults = await listenDesktopWindowActionResult(onWindowResult);
        context.signal?.addEventListener('abort', onAbort, { once: true });
        context.signal?.throwIfAborted();
        const admission = await Promise.race([
            startNativeCapture(nativeInput).then(snapshot => ({ snapshot })),
            result.then(outcome => ({ outcome })),
        ]);
        if ('outcome' in admission) return admission.outcome;
        const started = admission.snapshot;
        if ('operationRef' in started) operationRef = started.operationRef;
        else if (started.status === 'failed' || started.status === 'unavailable') return failure(started.reason);
        else return failure('cancelled');
        const observed = latestSnapshot;
        onSnapshot(started);
        if (observed) onSnapshot(observed);
        return await result;
    } finally {
        context.signal?.removeEventListener('abort', onAbort);
        stopState(); stopResults?.();
    }
}
