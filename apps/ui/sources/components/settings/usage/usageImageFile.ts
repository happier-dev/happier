import { Platform } from 'react-native';
import { log } from '@/log';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { setClipboardImageSafe } from '@/utils/ui/clipboard';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { readCanonicalPaddedBase64DecodedLength } from '@happier-dev/protocol/crypto/base64';
import type { UsageRecapDeliveryOutcome } from '@happier-dev/protocol/usage/usageRecap';

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

async function shareUsageImageOnNative(file: UsageImageFile, intent: 'save' | 'share', authority: UsageImageAuthority): Promise<UsageRecapDeliveryOutcome> {
    const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: file.fileName });
    if (!sink.ok) throw new Error(sink.error);
    let retainCacheFile = false;
    try {
        assertImageCurrent(authority);
        await sink.writeBytes(decodeBase64(file.base64));
        await sink.close();
        assertImageCurrent(authority);
        const result = await shareNativeCacheFile({ fileUri: sink.fileUri, name: file.fileName, mimeType: file.mediaType, action: intent,
            isCurrent: () => !authority.signal?.aborted && authority.isCurrent?.() !== false });
        if (result.status === 'canceled') return { kind: 'cancelled' };
        if (result.status === 'unavailable') return { kind: 'unavailable', reason: 'delivery_target_unavailable' };
        retainCacheFile = result.retainCacheFile;
        return result.completion === 'confirmed' ? { kind: 'delivered' }
            : { kind: 'failed', reason: 'outcome_unobservable', handoff: 'presented' };
    } finally {
        if (!retainCacheFile) await sink.cleanup();
    }
}

/**
 * Deliver already-produced image bytes with the person's explicit intent: Save downloads (web) or
 * opens the system sheet that offers Save Image (native); Share uses the platform share target when
 * one exists; Copy places the image on the clipboard.
 */
export async function deliverUsageImageFileResult(file: UsageImageFile, intent: 'save' | 'share' | 'copy', authority: UsageImageAuthority = {}): Promise<UsageRecapDeliveryOutcome> {
    try {
        assertImageCurrent(authority);
        if (intent === 'copy') return await setClipboardImageSafe(file.base64)
            ? { kind: 'delivered' } : { kind: 'unavailable', reason: 'clipboard_unavailable' };
        if (Platform.OS !== 'web') return await shareUsageImageOnNative(file, intent, authority);
        if (intent === 'share' && typeof navigator !== 'undefined' && typeof navigator.share === 'function'
            && typeof navigator.canShare === 'function') {
            const bytes = decodeBase64(file.base64);
            // A plain ArrayBuffer copy: `File` parts do not admit a view over a shared buffer type.
            const shared = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
                file.fileName, { type: file.mediaType });
            if (navigator.canShare({ files: [shared] })) {
                assertImageCurrent(authority);
                await navigator.share({ files: [shared] });
                return { kind: 'delivered' };
            }
        }
        assertImageCurrent(authority);
        return downloadDataUriOnWeb(`data:${file.mediaType};base64,${file.base64}`, file.fileName)
            ? { kind: 'delivered' } : { kind: 'failed', reason: 'delivery_failed' };
    } catch (error) {
        if (authority.signal?.aborted || authority.isCurrent?.() === false
            || error instanceof Error && error.name === 'AbortError') return { kind: 'cancelled' };
        log.log(`Failed to deliver usage image: ${error instanceof Error ? error.message : String(error)}`);
        return { kind: 'failed', reason: 'delivery_failed' };
    }
}
