import { createSessionFilePreviewSource } from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveStoredImageReadScope } from '@/sync/domains/session/media/resolveStoredImageReadScope';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { BrowserAnnotationViewportCaptureResult } from './captureProvider';

import { dispatchBrowserContextActionViaMachineRpc } from './machineRpc';
import type {
    BrowserAnnotationCaptureProvider,
    BrowserAnnotationCaptureRequest,
    BrowserContextUnavailableReason,
} from './types';

function unavailable(reasonCode: BrowserContextUnavailableReason['reasonCode']): Extract<BrowserAnnotationViewportCaptureResult, { status: 'unavailable' }> {
    return {
        status: 'unavailable',
        reason: {
            reasonCode,
            lifecycleState: reasonCode === 'browser_context_annotation_capture_failed'
                ? 'captureFailed'
                : 'adapterUnavailable',
            message: reasonCode === 'browser_context_annotation_capture_failed'
                ? 'Browser annotation capture failed.'
                : 'Browser annotation capture is unavailable for this view.',
        },
    };
}

function buildContextId(request: BrowserAnnotationCaptureRequest): string {
    const segment = (value: string | number): string => String(value)
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, 64);
    return [
        'browser_annotation',
        segment(request.browserSessionId),
        segment(request.viewId),
        segment(request.navigationGeneration),
        segment(request.capturedAtMs),
    ].join('_');
}

export function createManagedChromiumBrowserAnnotationCaptureProvider(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
    /** Workspace of the invoking Happier Session, never the browser's own session id. */
    previewScope?: WorkspaceScopeBase | null;
    /** Published by the exact capturing Machine, for daemon-relative media. */
    machineHappyHomeDir?: string | null;
}>): BrowserAnnotationCaptureProvider {
    const machineId = input.machineId.trim();
    const available = machineId.length > 0;
    const provider: BrowserAnnotationCaptureProvider = {
        available,
        async captureViewport(request): Promise<BrowserAnnotationViewportCaptureResult> {
            if (!available || request.adapterKind !== 'chromiumSidecar') return unavailable('browser_context_annotation_capture_unavailable');
            const result = await dispatchBrowserContextActionViaMachineRpc({ machineId, serverId: input.serverId, signal: input.signal,
                actionId: 'browser.context.captureScreenshot', input: { browserSessionId: request.browserSessionId,
                    viewId: request.viewId, navigationGeneration: request.navigationGeneration, contextId: buildContextId(request) } });
            if (!result.ok) return unavailable(result.reason === 'invalid_response'
                ? 'browser_context_annotation_capture_failed' : 'browser_context_annotation_capture_unavailable');
            const screenshot = result.result;
            if (Array.isArray(screenshot) || !('kind' in screenshot) || screenshot.kind !== 'browserScreenshot') {
                return unavailable('browser_context_annotation_capture_failed');
            }
            const file = screenshot.media.file;
            if (!file || !screenshot.viewport) return unavailable('browser_context_annotation_capture_failed');
            const previewScope = resolveStoredImageReadScope({ storage: file.storage, sessionScope: input.previewScope ?? null,
                daemon: { serverId: input.serverId ?? null, machineId, happyHomeDir: input.machineHappyHomeDir ?? null } });
            if (!previewScope) return unavailable('browser_context_annotation_capture_failed');
            const preview = await createSessionFilePreviewSource({ scope: previewScope, filePath: file.path,
                mimeType: file.mimeType, expectedSizeBytes: screenshot.media.sizeBytes, maxBytes: null, signal: input.signal, retainBytes: true });
            if (!preview.ok) return { status: 'unavailable', reason: {
                reasonCode: 'browser_context_annotation_capture_failed', lifecycleState: 'captureFailed',
                message: 'Browser annotation capture could not be read.',
            } };
            const source = preview.source;
            const uri = `data:image/png;base64,${encodeBase64(source.bytes!)}`;
            if (source.kind === 'object-url') source.revoke();
            else await source.delete();
            return { status: 'captured', source: { uri, width: screenshot.media.width, height: screenshot.media.height,
                scale: screenshot.media.width / screenshot.viewport.width },
                capture: screenshot.media,
                ...(request.currentUrl ? { pageUrl: request.currentUrl } : {}), ...(request.title ? { pageTitle: request.title } : {}) };
        },
    };
    return provider;
}
