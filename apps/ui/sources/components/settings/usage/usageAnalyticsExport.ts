import { Platform } from 'react-native';
import { log } from '@/log';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { setClipboardImageSafe, setClipboardStringSafe } from '@/utils/ui/clipboard';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import { t } from '@/text';
import {
    buildUsageAnalyticsExportPayload, buildUsageAnalyticsSummaryText,
    buildUsagePivotCsv, buildUsagePivotTableExport,
    type UsageAnalyticsExportInput,
} from '@/sync/domains/usage/usageAnalyticsExport';
import {
    exportUsageCsvDocument, exportUsageTextDocument, formatUsageExportFileTimestamp, shareUsageExportCacheFile,
} from './usageExportFile';

async function shareTextOnWeb(text: string): Promise<boolean> {
    if (typeof navigator !== 'undefined' && typeof (navigator as { share?: unknown }).share === 'function') {
        await (navigator as Navigator & { share: (data: { title?: string; text?: string }) => Promise<void> }).share({
            title: t('usage.summary.title'),
            text,
        });
        return true;
    }

    return setClipboardStringSafe(text);
}

async function shareTextOnNative(text: string): Promise<boolean> {
    const shared = await shareUsageExportCacheFile({
        content: text,
        fileName: `usage-summary-${formatUsageExportFileTimestamp(new Date())}.txt`,
    });
    // A platform that cannot take the file still owes the reader the numbers,
    // so the summary goes to the clipboard rather than silently failing.
    return shared ? true : setClipboardStringSafe(text);
}

export async function shareUsageAnalyticsSummary(input: UsageAnalyticsExportInput): Promise<boolean> {
    const summaryText = buildUsageAnalyticsSummaryText(input);
    if (Platform.OS === 'web') {
        return await shareTextOnWeb(summaryText);
    }
    return await shareTextOnNative(summaryText);
}

function downloadDataUriOnWeb(dataUri: string, fileName: string): boolean {
    try {
        const anchor = document.createElement('a');
        anchor.href = dataUri;
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
        try {
            anchor.remove();
        } catch {
            // ignore
        }
        return true;
    } catch {
        return false;
    }
}

/** A rendered usage image as file bytes: the one capture output every delivery below consumes. */
export type UsageImageFile = Readonly<{ mediaType: 'image/png'; fileName: string; base64: string }>;

export type UsageImageAuthority = Readonly<{ signal?: AbortSignal; isCurrent?: () => boolean }>;
function assertImageCurrent(authority: UsageImageAuthority): void {
    authority.signal?.throwIfAborted();
    if (authority.isCurrent?.() === false) throw new Error('action_account_scope_changed');
}

/**
 * Capture a mounted view as PNG bytes (react-native-view-shot, the tour's `captureStageFrame`
 * pattern). Production only: no file, clipboard or share effect happens here.
 */
export async function captureUsageViewPng(node: unknown, authority: UsageImageAuthority = {}): Promise<string> {
    assertImageCurrent(authority);
    if (Platform.OS === 'web') {
        const viewShotWeb = (await import('react-native-view-shot/src/RNViewShot.web')).default;
        assertImageCurrent(authority);
        const dataUri: string = await viewShotWeb.captureRef(node, { format: 'png', quality: 1, result: 'data-uri' });
        assertImageCurrent(authority);
        const prefix = 'data:image/png;base64,';
        if (!dataUri.startsWith(prefix)) throw new Error('usage_image_capture_invalid');
        const base64 = dataUri.slice(prefix.length);
        if (readCanonicalPaddedBase64DecodedLength(base64) === null) throw new Error('usage_image_capture_invalid');
        return base64;
    }
    const { captureRef, releaseCapture } = await import('react-native-view-shot');
    assertImageCurrent(authority);
    // Boundary cast: callers pass a mounted native view ref (same contract as the tour's captureStageFrame).
    const captureUri = await captureRef(node as Parameters<typeof captureRef>[0], { format: 'png', quality: 1, result: 'tmpfile' });
    try {
        assertImageCurrent(authority);
        const { File } = await import('expo-file-system');
        // View-shot iOS returns a raw temporary path; Expo File requires a file URL.
        const bytes = await new File(captureUri.startsWith('file://') ? captureUri : `file://${encodeURI(captureUri)}`).bytes();
        assertImageCurrent(authority);
        return encodeBase64(bytes);
    } finally {
        releaseCapture(captureUri);
    }
}

async function shareUsageImageOnNative(file: UsageImageFile, authority: UsageImageAuthority): Promise<boolean> {
    const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: file.fileName });
    if (!sink.ok) throw new Error(sink.error);
    let retainCacheFile = false;
    try {
        assertImageCurrent(authority);
        await sink.writeBytes(decodeBase64(file.base64));
        await sink.close();
        assertImageCurrent(authority);
        const result = await shareNativeCacheFile({ fileUri: sink.fileUri, name: file.fileName, mimeType: file.mediaType,
            isCurrent: () => !authority.signal?.aborted && authority.isCurrent?.() !== false });
        if (result.status !== 'shared') return false;
        retainCacheFile = result.retainCacheFile;
        return true;
    } finally {
        if (!retainCacheFile) await sink.cleanup();
    }
}

/**
 * Deliver already-produced image bytes with the person's explicit intent: Save downloads (web) or
 * opens the system sheet that offers Save Image (native); Share uses the platform share target when
 * one exists; Copy places the image on the clipboard.
 */
export async function deliverUsageImageFile(file: UsageImageFile, intent: 'save' | 'share' | 'copy', authority: UsageImageAuthority = {}): Promise<boolean> {
    try {
        assertImageCurrent(authority);
        if (intent === 'copy') return await setClipboardImageSafe(file.base64);
        if (Platform.OS !== 'web') return await shareUsageImageOnNative(file, authority);
        if (intent === 'share' && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
            && typeof navigator.canShare === 'function') {
            const bytes = decodeBase64(file.base64);
            // A plain ArrayBuffer copy: `File` parts do not admit a view over a shared buffer type.
            const shared = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
                file.fileName, { type: file.mediaType });
            if (navigator.canShare({ files: [shared] })) {
                assertImageCurrent(authority);
                await navigator.share({ files: [shared] });
                return true;
            }
        }
        assertImageCurrent(authority);
        return downloadDataUriOnWeb(`data:${file.mediaType};base64,${file.base64}`, file.fileName);
    } catch (error) {
        log.log(`Failed to deliver usage image: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

export async function exportUsageAnalyticsJson(input: UsageAnalyticsExportInput): Promise<boolean> {
    const payload = buildUsageAnalyticsExportPayload(input);
    return await exportUsageTextDocument({
        content: `${JSON.stringify(payload, null, 2)}\n`,
        fileName: `usage-${formatUsageExportFileTimestamp(new Date())}.json`,
        mimeType: 'application/json',
    });
}

/**
 * Export the active pivot dimension's ranked table as CSV (E-5). Reuses the same
 * web download / native share plumbing as the JSON export — no new export UI,
 * just the additional format on the existing actions row.
 */
export async function exportUsagePivotCsv(input: UsageAnalyticsExportInput): Promise<boolean> {
    const table = buildUsagePivotTableExport(input);
    return await exportUsageCsvDocument({
        csv: buildUsagePivotCsv(input),
        fileName: `usage-${table.dimension}-${formatUsageExportFileTimestamp(new Date())}.csv`,
    });
}
