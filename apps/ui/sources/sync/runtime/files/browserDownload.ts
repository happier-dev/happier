import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { BrowserInteractionStateV1 } from '@happier-dev/protocol';
import type { BrowserInteractionResultV1 } from '@happier-dev/protocol/browser/automation/v1';
import type { BrowserViewerInputEvent } from '@/components/browser/adapters/BrowserStreamedTarget';
import { readRegisteredBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { decodeBase64 } from '@/encryption/base64';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { createPlatformDownloadFileSink } from './platformDownloadFileSink';
import { downloadWebFile } from './downloadWebFile';
import { shareNativeCacheFile } from './nativeCacheFileSink';

type SaveBrowserDownloadArgs = Parameters<NonNullable<ActionExecutorDeps['saveClientBrowserDownload']>>[0];

/** Resolve the exact Account's existing mounted Browser owner once at handoff admission. */
export async function saveBrowserDownload(input: SaveBrowserDownloadArgs, scope: ServerAccountScope): ReturnType<NonNullable<ActionExecutorDeps['saveClientBrowserDownload']>> {
    throwIfAborted(input.signal);
    const { reference } = input;
    const control = readRegisteredBrowserRuntimeControlAdapter(reference.browserSessionId, reference.viewId, scope);
    if (!control?.saveDownload) {
        return { ok: false, errorCode: 'browser_download_unavailable', error: 'browser_download_unavailable' };
    }
    try {
        return await control.saveDownload({ machineId: reference.machineId, viewId: reference.viewId, downloadId: reference.downloadId,
            fileName: input.fileName, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
        throwIfAborted(input.signal);
        const errorCode = error instanceof Error ? error.message : 'file_save_failed';
        return { ok: false, errorCode, error: errorCode };
    }
}

/** Stream binary ranges into the shared sink; the platform handoff owns its final cleanup. */
export async function saveBrowserDownloadRanges(input: Readonly<{
    download: BrowserInteractionStateV1['downloads'][number];
    fileName?: string;
    signal?: AbortSignal;
    maxFrameBytes?: number;
    request: (event: BrowserViewerInputEvent, signal?: AbortSignal) => Promise<BrowserInteractionResultV1 | null>;
}>): Promise<Readonly<{ status: 'saved' | 'canceled' }>> {
    const { download, signal } = input;
    throwIfAborted(signal);
    if (download.state !== 'completed') throw new Error('download_not_completed');
    const name = input.fileName ?? download.name;
    const allocated = await createPlatformDownloadFileSink({ name, sizeBytes: download.receivedBytes });
    let retain = false;
    try {
        let offset = 0;
        for (;;) {
            throwIfAborted(signal);
            const result = await input.request({ kind: 'download', downloadId: download.downloadId, offset,
                // No local range cap: the negotiated stream budget owns the ceiling.
                byteLength: input.maxFrameBytes ?? Math.max(1, download.receivedBytes - offset) }, signal);
            throwIfAborted(signal);
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
        throwIfAborted(signal);
        if (allocated.kind === 'web') {
            downloadWebFile(await allocated.sink.getFile(), name, allocated.sink.cleanup);
            retain = true;
            return { status: 'saved' };
        }
        const shared = await shareNativeCacheFile({ fileUri: allocated.sink.fileUri, name, action: 'save',
            isCurrent: () => signal?.aborted !== true });
        if (shared.status === 'unavailable') throw new Error('file_sharing_unavailable');
        if (shared.status === 'canceled') return { status: 'canceled' };
        retain = shared.retainCacheFile;
        return { status: 'saved' };
    } finally { if (!retain) await allocated.sink.cleanup(); }
}
