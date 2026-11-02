import type { BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import {
    captureBrowserPageReference,
    cancelBrowserAnnotationMode,
    startBrowserAnnotationMode,
} from './actions';
import { attachBrowserContextToComposer } from './state';
import type {
    BrowserAnnotationModeResult,
    BrowserContextAttachResult,
    BrowserContextState,
    BrowserContextUnavailableReason,
} from './types';

function createUnavailableReason(
    reasonCode: BrowserContextUnavailableReason['reasonCode'],
    lifecycleState: BrowserContextUnavailableReason['lifecycleState'],
    message: string,
): BrowserContextUnavailableReason {
    return { reasonCode, lifecycleState, message };
}

function buildAttachmentId(contextId: string): string {
    return `browser_context_attachment:${contextId}`;
}

export type AttachActiveBrowserPageReferenceResult = BrowserContextAttachResult;

export function attachActiveBrowserPageReference(params: Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
    capturedAtMs: number;
}>): AttachActiveBrowserPageReferenceResult {
    if (!params.view) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_view_unavailable',
                'adapterUnavailable',
                'No active browser view is available to attach.',
            ),
        };
    }

    const captured = captureBrowserPageReference({
        state: params.state,
        browserContextEnabled: params.browserContextEnabled,
        contextCapabilities: params.contextCapabilities,
        adapterCapabilities: params.view.adapterCapabilities,
        viewId: params.view.viewId,
        target: params.view.target,
        page: {
            url: params.view.currentUrl,
            title: params.view.title,
            faviconUrl: params.view.faviconUrl,
            navigationGeneration: params.view.navigationGeneration,
            capturedAtMs: params.capturedAtMs,
        },
    });

    if (captured.status !== 'captured') {
        return captured;
    }

    return attachBrowserContextToComposer(captured.state, {
        attachmentId: buildAttachmentId(captured.itemId),
        contextId: captured.itemId,
    });
}

export type StartActiveBrowserAnnotationModeResult = BrowserAnnotationModeResult;

export function startActiveBrowserAnnotationMode(params: Readonly<{
    state: BrowserContextState;
    browserContextEnabled: boolean;
    attachmentsUploadsEnabled?: boolean;
    contextCapabilities: BrowserContextCapabilities;
    view: BrowserControlViewState | null;
    startedAtMs: number;
}>): StartActiveBrowserAnnotationModeResult {
    if (!params.view) {
        return {
            status: 'unavailable',
            state: params.state,
            reason: createUnavailableReason(
                'browser_context_view_unavailable',
                'adapterUnavailable',
                'No active browser view is available to annotate.',
            ),
        };
    }

    return startBrowserAnnotationMode(params.state, {
        browserContextEnabled: params.browserContextEnabled,
        attachmentsUploadsEnabled: params.attachmentsUploadsEnabled,
        contextCapabilities: params.contextCapabilities,
        adapterCapabilities: params.view.adapterCapabilities,
        browserSessionId: params.view.browserSessionId,
        viewId: params.view.viewId,
        navigationGeneration: params.view.navigationGeneration,
        startedAtMs: params.startedAtMs,
    });
}

export function cancelActiveBrowserAnnotationMode(params: Readonly<{
    state: BrowserContextState;
    view: BrowserControlViewState | null;
}>): BrowserContextState {
    if (!params.view) return params.state;
    return cancelBrowserAnnotationMode(params.state, { viewId: params.view.viewId });
}
