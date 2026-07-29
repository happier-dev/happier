import type { BrowserContextItemV1 } from '@happier-dev/protocol';

import { dispatchBrowserContextActionViaMachineRpc } from './machineRpc';
import type {
    BrowserAnnotationCaptureProvider,
    BrowserAnnotationCaptureProviderResult,
    BrowserAnnotationCaptureRequest,
    BrowserContextUnavailableReason,
} from './types';

function unavailable(reasonCode: BrowserContextUnavailableReason['reasonCode']): BrowserAnnotationCaptureProviderResult {
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

function capturedFromAnnotationItem(
    request: BrowserAnnotationCaptureRequest,
    item: Extract<BrowserContextItemV1, { kind: 'browserAnnotation' }>,
): BrowserAnnotationCaptureProviderResult {
    return {
        status: 'captured',
        browserSessionId: request.browserSessionId,
        viewId: request.viewId,
        navigationGeneration: request.navigationGeneration,
        capturedAtMs: item.capturedAtMs,
        media: item.media,
        target: item.target,
        ...(item.comment ? { comment: item.comment } : {}),
        ...(item.styleIntent ? { styleIntent: item.styleIntent } : {}),
        ...(item.stroke ? { stroke: item.stroke } : {}),
        ...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
        ...(item.pageTitle ? { pageTitle: item.pageTitle } : {}),
    };
}

function capturedFromScreenshotItem(
    request: BrowserAnnotationCaptureRequest,
    item: Extract<BrowserContextItemV1, { kind: 'browserScreenshot' }>,
): BrowserAnnotationCaptureProviderResult {
    return {
        status: 'captured',
        browserSessionId: request.browserSessionId,
        viewId: request.viewId,
        navigationGeneration: request.navigationGeneration,
        capturedAtMs: item.capturedAtMs,
        media: item.media,
        target: {
            kind: 'region',
            rect: { x: 0, y: 0, width: item.media.width, height: item.media.height },
        },
        ...(request.currentUrl ? { pageUrl: request.currentUrl } : {}),
        ...(request.title ? { pageTitle: request.title } : {}),
    };
}

export function createManagedChromiumBrowserAnnotationCaptureProvider(input: Readonly<{
    machineId: string;
    serverId?: string | null;
}>): BrowserAnnotationCaptureProvider {
    const machineId = input.machineId.trim();
    const available = machineId.length > 0;
    return {
        available,
        async captureAnnotation(request) {
            if (!available || request.adapterKind !== 'chromiumSidecar') {
                return unavailable('browser_context_annotation_capture_unavailable');
            }

            const contextId = buildContextId(request);
            const cropViewportRect = request.cropClip?.cssViewportRect;
            const cropRect = request.cropClip
                ? (cropViewportRect ?? request.cropClip.cssPageRect)
                : null;
            const result = await dispatchBrowserContextActionViaMachineRpc({
                machineId,
                serverId: input.serverId,
                actionId: request.cropClip
                    ? 'browser.context.annotation.captureRegion'
                    : 'browser.context.captureScreenshot',
                input: {
                    browserSessionId: request.browserSessionId,
                    viewId: request.viewId,
                    navigationGeneration: request.navigationGeneration,
                    contextId,
                    ...(cropRect
                        ? {
                            rect: {
                                ...cropRect,
                                coordinateSpace: cropViewportRect ? 'viewport' : 'page',
                            },
                        }
                        : {}),
                },
            });
            if (!result.ok) {
                return unavailable(
                    result.reason === 'invalid_response'
                        ? 'browser_context_annotation_capture_failed'
                        : 'browser_context_annotation_capture_unavailable',
                );
            }
            const routeResult = result.result;
            if ('ok' in routeResult && routeResult.ok === false) {
                return unavailable(
                    routeResult.errorCode === 'invalid_parameters'
                        ? 'browser_context_annotation_capture_failed'
                        : 'browser_context_annotation_capture_unavailable',
                );
            }
            if (!Array.isArray(routeResult) && 'kind' in routeResult && routeResult.kind === 'browserAnnotation') {
                return capturedFromAnnotationItem(request, routeResult);
            }
            if (!Array.isArray(routeResult) && 'kind' in routeResult && routeResult.kind === 'browserScreenshot') {
                return capturedFromScreenshotItem(request, routeResult);
            }
            return unavailable('browser_context_annotation_capture_failed');
        },
    };
}
