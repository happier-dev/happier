import * as React from 'react';
import type { ScreenCaptureDeliveryInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import {
    requestCaptureNewSession,
    executeDesktopWindowActionWithResult,
    type DesktopWindowActionResult,
} from '@/utils/platform/desktopWindowActionBridge';

type Delivery = ReturnType<typeof ScreenCaptureDeliveryInputSchema.parse>;
type NewSession = Readonly<{ captureRef: string; note?: string }>;
type DeliveryOperation = 'addToDraft' | 'send' | 'discard' | 'newSession';
type CaptureOperation = DeliveryOperation | 'recording.pause' | 'recording.resume' | 'recording.stop';
type FailedOperation = Readonly<{ action: 'addToDraft' | 'send' | 'newSession'; input: Delivery | NewSession; staged: boolean }>
    | Readonly<{ action: 'recording'; command: 'pause' | 'resume' | 'stop'; operationRef: number }>;
export type CaptureWindowActionState =
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'pending'; action: CaptureOperation }>
    | Readonly<{ status: 'settled'; result: DesktopWindowActionResult }>;

/** Thin window-side controls: no Sync, attachment store or draft writer is loaded here. */
export function useCaptureWindowActions(signal?: AbortSignal) {
    const [state, setState] = React.useState<CaptureWindowActionState>({ status: 'idle' });
    const failedOperation = React.useRef<FailedOperation | null>(null);
    const run = async (
        action: DeliveryOperation,
        input: Delivery | NewSession,
        retry = false,
    ) => {
        if (!signal?.aborted) setState({ status: 'pending', action });
        const result = await (action === 'newSession' ? requestCaptureNewSession(input, { signal }) : executeDesktopWindowActionWithResult({
            windowLabel: 'capture', actionIdentifier: `screenCapture.${action}`, data: { ...input },
            ...(retry ? { intent: 'retry' as const } : {}),
        }, { signal }));
        if (signal?.aborted) return result;
        const details = result.details;
        const staged = Boolean(details && typeof details === 'object' && 'captureStaged' in details && details.captureStaged === true);
        const delivered = details && typeof details === 'object' && 'delivered' in details ? details.delivered : null;
        const alreadyApplied = delivered !== null && typeof delivered === 'object';
        failedOperation.current = action !== 'discard' && !result.ok && !alreadyApplied ? { action, input, staged } : null;
        setState({ status: 'settled', result });
        return result;
    };
    return {
        state,
        pauseRecording: (operationRef: number) => runRecording('pause', operationRef),
        resumeRecording: (operationRef: number) => runRecording('resume', operationRef),
        stopRecording: (operationRef: number) => runRecording('stop', operationRef),
        showInFolder: (captureRef: string) => executeDesktopWindowActionWithResult({
            windowLabel: 'capture', actionIdentifier: 'screenCapture.showInFolder', data: { captureRef },
        }, { signal }),
        addToDraft: (input: Delivery) => run('addToDraft', input),
        send: (input: Delivery) => run('send', input),
        newSession: (input: NewSession) => run('newSession', input),
        discard: (captureRef: string) => run('discard', { captureRef }),
        retry: () => {
            const failed = failedOperation.current;
            return failed?.action === 'recording' ? runRecording(failed.command, failed.operationRef)
                : failed ? run(failed.action, failed.input, failed.action === 'send' && failed.staged) : null;
        },
    };

    async function runRecording(action: 'pause' | 'resume' | 'stop', operationRef: number) {
        if (!signal?.aborted) setState({ status: 'pending', action: `recording.${action}` });
        const result = await executeDesktopWindowActionWithResult({ windowLabel: 'capture',
            actionIdentifier: `screenCapture.recording.${action}`, data: { operationRef } }, { signal });
        if (!signal?.aborted) {
            failedOperation.current = result.ok ? null : { action: 'recording', command: action, operationRef };
            setState({ status: 'settled', result });
        }
        return result;
    }
}
