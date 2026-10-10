import { Platform } from 'react-native';
import { log } from '@/log';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';

export { escapeUsageCsvField, buildUsageCsvDocument } from '@happier-dev/protocol/usage/usageExport';

/**
 * The one place usage exports become a file.
 *
 * CSV escaping, the timestamped file name, the native cache write and the
 * web download are the same mechanics for every usage surface, so the personal
 * analytics export and the Team resource export share them instead of each
 * growing its own. Nothing here knows what a usage row means: callers hand it
 * finished text and a name.
 */

export function formatUsageExportFileTimestamp(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

/** Shares a written cache file, reporting whether the platform actually took it. */
export async function shareUsageExportCacheFile(input: Readonly<{
    content: string;
    fileName: string;
    mimeType?: string;
    isCurrent?: () => boolean;
}>): Promise<boolean> {
    if (input.isCurrent?.() === false) return false;
    try {
        const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: input.fileName });
        if (!sink.ok) throw new Error(sink.error);
        let retainCacheFile = false;
        try {
            await sink.writeBytes(new TextEncoder().encode(input.content));
            await sink.close();
            const result = await shareNativeCacheFile({ fileUri: sink.fileUri, name: input.fileName, mimeType: input.mimeType, isCurrent: input.isCurrent });
            if (result.status !== 'shared') return false;
            retainCacheFile = result.retainCacheFile;
            return true;
        } finally {
            if (!retainCacheFile) await sink.cleanup();
        }
    } catch (error) {
        log.log(`Failed to export usage cache file: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

function downloadTextOnWeb(content: string, fileName: string, mimeType: string): boolean {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.rel = 'noopener noreferrer';
        try {
            anchor.style.display = 'none';
        } catch {
            // ignore
        }
        try {
            document.body?.appendChild(anchor);
        } catch {
            // ignore
        }
        anchor.click();
        setTimeout(() => {
            try {
                anchor.remove();
            } catch {
                // ignore
            }
        }, 0);
    } finally {
        setTimeout(() => {
            try {
                URL.revokeObjectURL(url);
            } catch {
                // ignore
            }
        }, 1000);
    }
    return true;
}

/** Downloads on web, shares from the native cache elsewhere. */
export async function exportUsageTextDocument(input: Readonly<{
    content: string;
    fileName: string;
    mimeType: string;
    isCurrent?: () => boolean;
}>): Promise<boolean> {
    if (input.isCurrent?.() === false) return false;
    if (Platform.OS === 'web') {
        return downloadTextOnWeb(input.content, input.fileName, input.mimeType);
    }
    return await shareUsageExportCacheFile(input);
}

export async function exportUsageCsvDocument(input: Readonly<{
    csv: string;
    fileName: string;
    isCurrent?: () => boolean;
}>): Promise<boolean> {
    return await exportUsageTextDocument({
        content: input.csv,
        fileName: input.fileName,
        mimeType: 'text/csv',
        isCurrent: input.isCurrent,
    });
}
