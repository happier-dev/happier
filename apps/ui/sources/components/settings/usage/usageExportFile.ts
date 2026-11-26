import { Platform } from 'react-native';
import type { UsageRecapDeliveryOutcome } from '@happier-dev/protocol/usage/usageRecap';
import { log } from '@/log';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';

/**
 * The one place usage exports become a file.
 *
 * The native cache write and the web download are the same mechanics for every
 * usage surface (the `usage.export` Action's result, the plan calendar and the
 * Team resource export). Nothing here knows what a usage row means: callers
 * hand it finished text and a name.
 */

/** Shares a written cache file, reporting whether the platform actually took it. */
type UsageTextDocument = Readonly<{
    content: string;
    fileName: string;
    mimeType: string;
    isCurrent?: () => boolean;
}>;

async function shareUsageExportCacheFile(input: UsageTextDocument): Promise<UsageRecapDeliveryOutcome> {
    try {
        const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: input.fileName });
        if (!sink.ok) throw new Error(sink.error);
        let retainCacheFile = false;
        try {
            await sink.writeBytes(new TextEncoder().encode(input.content));
            await sink.close();
            const result = await shareNativeCacheFile({ fileUri: sink.fileUri, name: input.fileName, mimeType: input.mimeType, isCurrent: input.isCurrent });
            if (result.status === 'canceled') return { kind: 'cancelled' };
            if (result.status === 'unavailable') return { kind: 'unavailable', reason: 'delivery_target_unavailable' };
            retainCacheFile = result.retainCacheFile;
            return result.completion === 'confirmed' ? { kind: 'delivered' }
                : { kind: 'failed', reason: 'outcome_unobservable', handoff: 'presented' };
        } finally {
            if (!retainCacheFile) await sink.cleanup().catch(() => { /* The sink reports cleanup beside the settled result. */ });
        }
    } catch (error) {
        log.log(`Failed to export usage cache file: ${error instanceof Error ? error.message : String(error)}`);
        return input.isCurrent?.() === false ? { kind: 'cancelled' } : { kind: 'failed', reason: 'delivery_failed' };
    }
}

function downloadTextOnWeb(content: string, fileName: string, mimeType: string): void {
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
}

/** Downloads on web, shares from the native cache elsewhere. */
export async function deliverUsageTextDocument(input: UsageTextDocument): Promise<UsageRecapDeliveryOutcome> {
    if (input.isCurrent?.() === false) return { kind: 'cancelled' };
    if (Platform.OS === 'web') {
        downloadTextOnWeb(input.content, input.fileName, input.mimeType);
        return { kind: 'delivered' };
    }
    return await shareUsageExportCacheFile(input);
}

/** Existing calendar and Team export buttons acknowledge the platform handoff. */
export async function exportUsageTextDocument(input: UsageTextDocument): Promise<boolean> {
    const result = await deliverUsageTextDocument(input);
    return result.kind === 'delivered' || result.kind === 'failed' && result.handoff === 'presented';
}
