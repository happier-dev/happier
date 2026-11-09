import type { BrowserAutomationActionResultV1, BrowserInteractionResultV1 } from '@happier-dev/protocol/browser/automation/v1';
import type { BrowserViewerInputEvent } from '../adapters/BrowserStreamedTarget';

/** Results are private to this stream and correlated by the input owner's request id. */
export function createBrowserStreamInputRelay(input: Readonly<{
    streamId: string;
    nextSequence: () => number;
    send: (event: BrowserViewerInputEvent, eventId: string, sequence: number) => void;
}>) {
    let closed = false;
    const pending = new Map<string, Readonly<{
        resolve: (result: BrowserInteractionResultV1 | null) => void;
        reject: (error: Error) => void;
    }>>();
    const send = (event: BrowserViewerInputEvent) => {
        if (closed) return;
        const next = input.nextSequence();
        input.send(event, `browser-input:${input.streamId}:${next}`, next);
    };
    return {
        send,
        request: (event: BrowserViewerInputEvent, signal?: AbortSignal): Promise<BrowserInteractionResultV1 | null> => new Promise((resolve, reject) => {
            if (closed) { reject(new Error('stream_closed')); return; }
            signal?.throwIfAborted();
            const next = input.nextSequence();
            const eventId = `browser-input:${input.streamId}:${next}`;
            const abort = () => { pending.delete(eventId); reject(signal?.reason ?? new Error('aborted')); };
            const cleanup = () => signal?.removeEventListener('abort', abort);
            pending.set(eventId, { resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); } });
            signal?.addEventListener('abort', abort, { once: true });
            try { input.send(event, eventId, next); }
            catch (error) { pending.delete(eventId); cleanup(); reject(error); }
        }),
        accept: (result: BrowserAutomationActionResultV1) => {
            const request = pending.get(result.automationRequestId);
            if (!request) return;
            pending.delete(result.automationRequestId);
            if (result.status === 'succeeded') request.resolve(result.interactionResult ?? null);
            else request.reject(new Error(result.errorCode ?? result.status));
        },
        dispose: () => {
            closed = true;
            for (const request of pending.values()) request.reject(new Error('stream_closed'));
            pending.clear();
        },
    };
}
