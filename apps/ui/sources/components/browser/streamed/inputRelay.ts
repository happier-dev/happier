import type { BrowserAutomationActionResultV1, BrowserInteractionResultV1 } from '@happier-dev/protocol/browser/automation/v1';
import type { BrowserViewerInputEvent } from '../adapters/BrowserStreamedTarget';
import { decodeBase64 } from '@/encryption/base64';
import { createPlatformDownloadFileSink } from '@/sync/runtime/files/platformDownloadFileSink';
import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import type { BrowserInteractionStateV1 } from '@happier-dev/protocol';

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
        request: (event: BrowserViewerInputEvent): Promise<BrowserInteractionResultV1 | null> => new Promise((resolve, reject) => {
            if (closed) { reject(new Error('stream_closed')); return; }
            const next = input.nextSequence();
            const eventId = `browser-input:${input.streamId}:${next}`;
            pending.set(eventId, { resolve, reject });
            try { input.send(event, eventId, next); }
            catch (error) { pending.delete(eventId); reject(error); }
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

/** Fetch one admitted range at a time into the existing platform download sink. */
export async function saveBrowserStreamDownload(input: Readonly<{
    download: BrowserInteractionStateV1['downloads'][number];
    maxFrameBytes?: number;
    request: ReturnType<typeof createBrowserStreamInputRelay>['request'];
}>): Promise<void> {
    const { download } = input;
    const allocated = await createPlatformDownloadFileSink({ name: download.name, sizeBytes: download.receivedBytes });
    let retain = false;
    try {
        let offset = 0;
        for (;;) {
            const result = await input.request({ kind: 'download', downloadId: download.downloadId, offset,
                // With no negotiated frame ceiling the remaining file is one range. An empty file
                // still needs a positive request to retrieve the owner's EOF.
                byteLength: input.maxFrameBytes ?? Math.max(1, download.receivedBytes - offset) });
            if (result?.kind !== 'download' || result.downloadId !== download.downloadId || result.offset !== offset) {
                throw new Error('invalid_download_range');
            }
            const bytes = decodeBase64(result.dataBase64, 'base64');
            await allocated.sink.writeBytes(bytes);
            offset += bytes.byteLength;
            if (result.eof) break;
            if (!bytes.byteLength) throw new Error('empty_download_range');
        }
        await allocated.sink.close();
        if (allocated.kind === 'web') {
            downloadWebFile(await allocated.sink.getFile(), download.name, allocated.sink.cleanup);
            retain = true; // downloadWebFile owns cleanup after the browser consumes the Blob.
        } else {
            const shared = await shareNativeCacheFile({ fileUri: allocated.sink.fileUri, name: download.name, action: 'save' });
            if (shared.status === 'unavailable') throw new Error('file_sharing_unavailable');
            retain = shared.status === 'shared' && shared.retainCacheFile;
        }
    } finally { if (!retain) await allocated.sink.cleanup(); }
}
