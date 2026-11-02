import { Platform } from 'react-native';
import { createWebDownloadFileSink, type WebDownloadFileSink } from '@/hooks/workspaces/transfers/webDownloadFileSink';
import { createNativeCacheFileSink, type NativeCacheFileSink } from './nativeCacheFileSink';
import { createDesktopDownloadFileSink } from './openInDefaultApp';
import { sanitizeFileUriSegment } from './fileUriPath';
import { invokeDesktopHost } from '@/utils/platform/desktopHost';
import { resolveWebDownloadMaxBytes } from './webFileBufferBudget';

/** Shared platform allocation; the transfer receiver remains the only byte writer. */
export async function createPlatformDownloadFileSink(input: Readonly<{
    name: string; sizeBytes: number; desktopOpening?: boolean; webMaxBytes?: number;
}>): Promise<Readonly<{ kind: 'web'; sink: WebDownloadFileSink }> | Readonly<{ kind: 'native'; sink: NativeCacheFileSink }>> {
    if (Platform.OS === 'web' && !input.desktopOpening) {
        return { kind: 'web', sink: await createWebDownloadFileSink({ expectedSizeBytes: input.sizeBytes,
            maxBytes: input.webMaxBytes ?? resolveWebDownloadMaxBytes() }) };
    }
    const sink = input.desktopOpening
        ? { ok: true as const, ...await createDesktopDownloadFileSink({
            fileName: sanitizeFileUriSegment(input.name, 'download'), invoke: invokeDesktopHost }) }
        : await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: input.name || 'download' });
    if (!sink.ok) throw new Error(sink.error);
    return { kind: 'native', sink };
}
