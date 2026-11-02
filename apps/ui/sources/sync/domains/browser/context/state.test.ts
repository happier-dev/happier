import { BROWSER_CONTEXT_SELECTION_MAX_CHARS, BROWSER_CONTEXT_SUMMARY_MAX_CHARS } from '@happier-dev/protocol/browser/context/v1';
import type {
    BrowserAdapterCapabilitiesV1} from '@happier-dev/protocol/browser/adapters/v1';
import type {
    BrowserContextCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type {
    BrowserDiagnosticsElementPickerResultV1,
} from '@happier-dev/protocol/browser/diagnostics/v1';
import { describe, expect, it } from 'vitest';

import {
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    markBrowserContextViewNavigation,
    resolveBrowserContextKindAvailability,
    selectBrowserContextComposerAttachments,
} from './state';

const contextCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference'],
    supportedAdapterKinds: ['localPreview'],
    screenshot: {
        supported: false,
        requiresAttachmentUploads: true,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const adapterCapabilities = {
    adapterKind: 'localPreview',
    supportedTargetKinds: ['localServicePreview'],
    supportedRenderEngines: ['webIframe'],
    navigation: {
        canNavigate: true,
        canGoBack: false,
        canGoForward: false,
        canReload: true,
        canStop: false,
    },
    diagnosticsFidelityByFamily: {
        pageInfo: 'previewProxy',
    },
    contextKinds: ['browserPageReference'],
    inputRouting: 'none',
    supportsDownloads: false,
    supportsUploads: false,
    supportsPopups: false,
    supportsPermissions: false,
    supportsStreamingDisplay: false,
    disabledReasons: [],
} satisfies BrowserAdapterCapabilitiesV1;

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
    },
} as const;

describe('browser context state', () => {
    it('captures a page-reference context item from target and page metadata when context is enabled', () => {
        const result = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/dashboard',
                title: 'Kitchen Sink Dashboard',
                faviconUrl: 'https://preview.localhost.test/favicon.ico',
                navigationGeneration: 7,
                capturedAtMs: 3_000,
            },
        });

        if (result.status !== 'captured') throw new Error('expected context capture to succeed');
        expect(result.state.itemsById[result.itemId]).toMatchObject({
            kind: 'browserPageReference',
            sourceViewId: 'view_1',
            targetId: 'preview_1',
            targetKind: 'localServicePreview',
            url: 'https://preview.localhost.test/dashboard',
            origin: 'https://preview.localhost.test',
            lifecycleState: 'available',
            redactionLevel: 'metadataOnly',
            fidelity: 'previewProxy',
        });
    });

    it('strips query and fragment values from metadata-only page-reference URLs before storing context', () => {
        const result = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/dashboard?previewToken=secret&publicToken=secret&token=secret&code=secret#secret',
                title: 'Kitchen Sink Dashboard',
                faviconUrl: 'https://preview.localhost.test/favicon.ico?token=secret#secret',
                navigationGeneration: 7,
                capturedAtMs: 3_000,
            },
        });

        if (result.status !== 'captured') throw new Error('expected context capture to succeed');
        const item = result.state.itemsById[result.itemId];
        expect(item).toMatchObject({
            url: 'https://preview.localhost.test/dashboard',
            faviconUrl: 'https://preview.localhost.test/favicon.ico',
            origin: 'https://preview.localhost.test',
            redactionLevel: 'metadataOnly',
        });
        expect(JSON.stringify(item)).not.toContain('secret');
        expect(JSON.stringify(item)).not.toContain('previewToken');
        expect(JSON.stringify(item)).not.toContain('publicToken');
        expect(JSON.stringify(item)).not.toContain('token=');
        expect(JSON.stringify(item)).not.toContain('code=');
        expect(JSON.stringify(item)).not.toContain('#secret');
    });

    it('uses available producer capability when a stale browser.context mirror is disabled', () => {
        const result = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: false,
            contextCapabilities: { ...contextCapabilities, enabled: false },
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/dashboard',
                navigationGeneration: 1,
                capturedAtMs: 3_000,
            },
        });

        expect(result.status).toBe('captured');
    });

    it('blocks capture for sensitive or private states instead of creating attachable context', () => {
        const result = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/login',
                navigationGeneration: 1,
                capturedAtMs: 3_000,
                privacyState: 'sensitiveFieldsPresent',
            },
        });

        if (result.status !== 'unavailable') throw new Error('expected sensitive context capture to be blocked');
        expect(result.reason.lifecycleState).toBe('sensitiveFieldsPresent');
        expect(result.state.itemsById).toEqual({});
    });

    it('requires the attachments.uploads gate for screenshot context when host policy requires uploads', () => {
        const reason = resolveBrowserContextKindAvailability({
            browserContextEnabled: true,
            attachmentsUploadsEnabled: false,
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserScreenshot'],
                screenshot: {
                    supported: true,
                    requiresAttachmentUploads: true,
                    maxBytes: 5_000_000,
                },
            },
            adapterCapabilities: {
                ...adapterCapabilities,
                contextKinds: ['browserScreenshot'],
            },
            kind: 'browserScreenshot',
        });

        expect(reason).toMatchObject({
            lifecycleState: 'policyDenied',
            reasonCode: 'browser_context_attachment_uploads_disabled',
        });
    });

    it('captures screenshot context as a media reference only when upload policy and privacy state allow it', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.captureBrowserScreenshotReference).toBeTypeOf('function');
        const captureBrowserScreenshotReference = module.captureBrowserScreenshotReference as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                attachmentsUploadsEnabled: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                viewId: string;
                navigationGeneration: number;
                capturedAtMs: number;
                media: {
                    mediaId: string;
                    mediaKind: 'image';
                    width: number;
                    height: number;
                    sizeBytes: number;
                };
                privacyState?: 'sensitiveOrigin' | 'sensitiveFieldsPresent' | 'ephemeralOnly' | null;
                contextId?: string;
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;

        const result = captureBrowserScreenshotReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserScreenshot'],
                screenshot: {
                    supported: true,
                    requiresAttachmentUploads: true,
                    maxBytes: 5_000_000,
                },
            },
            adapterCapabilities: {
                ...adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    screenshot: 'cdp',
                },
                contextKinds: ['browserScreenshot'],
            },
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 3_500,
            media: {
                mediaId: 'media_1',
                mediaKind: 'image',
                width: 1280,
                height: 720,
                sizeBytes: 300_000,
            },
        });

        if (result.status !== 'captured') throw new Error('expected screenshot context capture to succeed');
        expect(result.state.itemsById[result.itemId]).toMatchObject({
            kind: 'browserScreenshot',
            sourceViewId: 'view_1',
            lifecycleState: 'available',
            redactionLevel: 'metadataOnly',
            fidelity: 'cdp',
            media: {
                mediaId: 'media_1',
                mediaKind: 'image',
            },
        });
        expect(JSON.stringify(result.state.itemsById[result.itemId])).not.toContain('inlineBytes');

        const blocked = captureBrowserScreenshotReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserScreenshot'],
                screenshot: {
                    supported: true,
                    requiresAttachmentUploads: true,
                },
            },
            adapterCapabilities: {
                ...adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    screenshot: 'cdp',
                },
                contextKinds: ['browserScreenshot'],
            },
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 3_500,
            privacyState: 'sensitiveOrigin',
            media: {
                mediaId: 'media_blocked',
                mediaKind: 'image',
                width: 1280,
                height: 720,
                sizeBytes: 300_000,
            },
        });

        expect(blocked).toMatchObject({
            status: 'unavailable',
            reason: {
                lifecycleState: 'sensitiveOrigin',
                reasonCode: 'browser_context_sensitive_origin',
            },
        });
        expect(blocked.state.itemsById).toEqual({});
    });

    it('captures bounded text and DOM summaries without retaining unavailable sensitive context', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.captureBrowserTextSelection).toBeTypeOf('function');
        expect(module.captureBrowserSummaryContext).toBeTypeOf('function');
        const captureBrowserTextSelection = module.captureBrowserTextSelection as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                viewId: string;
                navigationGeneration: number;
                capturedAtMs: number;
                text: string;
                privacyState?: 'sensitiveOrigin' | 'sensitiveFieldsPresent' | 'ephemeralOnly' | null;
                contextId?: string;
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;
        const captureBrowserSummaryContext = module.captureBrowserSummaryContext as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                browserDiagnosticsEnabled?: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                viewId: string;
                navigationGeneration: number;
                capturedAtMs: number;
                kind: 'browserPageTextSummary' | 'browserDomSnapshotSummary' | 'browserNetworkSummary' | 'browserConsoleSummary';
                summary: string;
                privacyState?: 'sensitiveOrigin' | 'sensitiveFieldsPresent' | 'ephemeralOnly' | null;
                contextId?: string;
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;
        const textContextCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: [
                'browserTextSelection',
                'browserDomSnapshotSummary',
                'browserNetworkSummary',
            ],
            text: {
                maxSelectionChars: 12,
                maxSummaryChars: 24,
            },
        } satisfies BrowserContextCapabilities;
        const textAdapterCapabilities = {
            ...adapterCapabilities,
            diagnosticsFidelityByFamily: {
                elements: 'injectedPage',
                network: 'previewProxy',
            },
            contextKinds: [
                'browserTextSelection',
                'browserDomSnapshotSummary',
                'browserNetworkSummary',
            ],
        } satisfies BrowserAdapterCapabilitiesV1;

        const selected = captureBrowserTextSelection({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities: textContextCapabilities,
            adapterCapabilities: textAdapterCapabilities,
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 4_000,
            text: 's'.repeat(BROWSER_CONTEXT_SELECTION_MAX_CHARS + 1),
        });

        if (selected.status !== 'captured') throw new Error('expected selected text capture to succeed');
        expect(selected.state.itemsById[selected.itemId]).toMatchObject({
            kind: 'browserTextSelection',
            text: 's'.repeat(BROWSER_CONTEXT_SELECTION_MAX_CHARS),
            truncated: true,
            redactionLevel: 'summaryOnly',
            fidelity: 'injectedPage',
        });

        const domSummary = captureBrowserSummaryContext({
            state: selected.state,
            browserContextEnabled: true,
            contextCapabilities: textContextCapabilities,
            adapterCapabilities: textAdapterCapabilities,
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 4_100,
            kind: 'browserDomSnapshotSummary',
            summary: 'm'.repeat(BROWSER_CONTEXT_SUMMARY_MAX_CHARS + 1),
        });

        if (domSummary.status !== 'captured') throw new Error('expected DOM summary capture to succeed');
        expect(domSummary.state.itemsById[domSummary.itemId]).toMatchObject({
            kind: 'browserDomSnapshotSummary',
            summary: 'm'.repeat(BROWSER_CONTEXT_SUMMARY_MAX_CHARS),
            truncated: true,
            redactionLevel: 'summaryOnly',
            fidelity: 'injectedPage',
        });

        const blocked = captureBrowserTextSelection({
            state: domSummary.state,
            browserContextEnabled: true,
            contextCapabilities: textContextCapabilities,
            adapterCapabilities: textAdapterCapabilities,
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 4_200,
            text: 'credential field text',
            privacyState: 'sensitiveFieldsPresent',
        });

        expect(blocked).toMatchObject({
            status: 'unavailable',
            reason: {
                lifecycleState: 'sensitiveFieldsPresent',
                reasonCode: 'browser_context_sensitive_fields_present',
            },
        });
        expect(Object.values(blocked.state.itemsById)).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ text: 'credential field text' }),
        ]));
    });

    it('uses available summary capability when the diagnostics feature mirror is disabled', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.captureBrowserSummaryContext).toBeTypeOf('function');
        const captureBrowserSummaryContext = module.captureBrowserSummaryContext as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                browserDiagnosticsEnabled?: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                viewId: string;
                navigationGeneration: number;
                capturedAtMs: number;
                kind: 'browserPageTextSummary' | 'browserDomSnapshotSummary' | 'browserNetworkSummary' | 'browserConsoleSummary';
                summary: string;
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;

        const result = captureBrowserSummaryContext({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            browserDiagnosticsEnabled: false,
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserNetworkSummary'],
            },
            adapterCapabilities: {
                ...adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    network: 'previewProxy',
                },
                contextKinds: ['browserNetworkSummary'],
            },
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 4_300,
            kind: 'browserNetworkSummary',
            summary: '1 failed request',
        });

        expect(result.status).toBe('captured');
        expect(Object.values(result.state.itemsById)).toEqual([expect.objectContaining({ kind: 'browserNetworkSummary', summary: '1 failed request' })]);

        const missingMirror = captureBrowserSummaryContext({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserNetworkSummary'],
            },
            adapterCapabilities: {
                ...adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    network: 'previewProxy',
                },
                contextKinds: ['browserNetworkSummary'],
            },
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 4_400,
            kind: 'browserNetworkSummary',
            summary: '1 failed request',
        });

        expect(missingMirror.status).toBe('captured');
        expect(Object.values(missingMirror.state.itemsById)).toEqual([expect.objectContaining({ kind: 'browserNetworkSummary', summary: '1 failed request' })]);
    });

    it('captures a selected element from diagnostics picker metadata without storing backend refs or DOM text', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.captureBrowserSelectedElement).toBeTypeOf('function');
        const captureBrowserSelectedElement = module.captureBrowserSelectedElement as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                browserDiagnosticsEnabled?: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                capturedAtMs: number;
                pickerResult: BrowserDiagnosticsElementPickerResultV1;
                contextId?: string;
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;

        const result = captureBrowserSelectedElement({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            browserDiagnosticsEnabled: true,
            contextCapabilities: {
                ...contextCapabilities,
                supportedContextKinds: ['browserSelectedElement'],
            },
            adapterCapabilities: {
                ...adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    elements: 'injectedPage',
                },
                contextKinds: ['browserSelectedElement'],
            },
            capturedAtMs: 4_500,
            pickerResult: {
                v: 1,
                pickerRequestId: 'picker_1',
                viewId: 'view_1',
                navigationGeneration: 7,
                tier: 'injectedPage',
                status: 'selected',
                audited: true,
                backendNodeRef: 'backend_node_secret',
                selectorPath: 'html > body > main:nth-of-type(1) > button',
                rect: {
                    x: 12,
                    y: 24,
                    width: 120,
                    height: 36,
                },
                accessibleName: 'Run task',
                componentName: 'RunTaskButton',
                sourceLocation: { file: 'src/RunTaskButton.tsx', line: 24, column: 8 },
            },
        });

        if (result.status !== 'captured') throw new Error('expected selected element capture to succeed');
        const item = result.state.itemsById[result.itemId];
        expect(item).toMatchObject({
            kind: 'browserSelectedElement',
            sourceViewId: 'view_1',
            sourceAdapterKind: 'localPreview',
            fidelity: 'injectedPage',
            capturedAtMs: 4_500,
            navigationGeneration: 7,
            lifecycleState: 'available',
            redactionLevel: 'metadataOnly',
            selectorPath: 'html > body > main:nth-of-type(1) > button',
            accessibleName: 'Run task',
            componentName: 'RunTaskButton',
            sourceLocation: { file: 'src/RunTaskButton.tsx', line: 24, column: 8 },
            rect: {
                x: 12,
                y: 24,
                width: 120,
                height: 36,
            },
        });
        expect(JSON.stringify(item)).not.toContain('backend_node_secret');
        expect(JSON.stringify(item)).not.toContain('outerHTMLPreview');
    });





    it('marks composer attachments stale when the source view navigates after capture', () => {
        const captured = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/dashboard',
                navigationGeneration: 7,
                capturedAtMs: 3_000,
            },
        });

        expect(captured.status).toBe('captured');
        if (captured.status !== 'captured') return;

        const attached = attachBrowserContextToComposer(captured.state, {
            attachmentId: 'attachment_1',
            contextId: captured.itemId,
        });
        const navigated = markBrowserContextViewNavigation(attached.state, {
            viewId: 'view_1',
            navigationGeneration: 8,
        });

        expect(selectBrowserContextComposerAttachments(navigated)).toEqual([
            expect.objectContaining({
                attachmentId: 'attachment_1',
                contextId: captured.itemId,
                state: 'navigationStale',
                requiresReconfirmBeforeSend: true,
                capturedNavigationGeneration: 7,
                currentNavigationGeneration: 8,
            }),
        ]);
    });

    it('removes a browser-context composer attachment without deleting the captured context item', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.removeBrowserContextComposerAttachment).toBeTypeOf('function');
        const removeBrowserContextComposerAttachment = module.removeBrowserContextComposerAttachment as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Readonly<{ attachmentId: string }>,
        ) => ReturnType<typeof createBrowserContextState>;

        const captured = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/dashboard',
                navigationGeneration: 7,
                capturedAtMs: 3_000,
            },
        });

        expect(captured.status).toBe('captured');
        if (captured.status !== 'captured') return;

        const attached = attachBrowserContextToComposer(captured.state, {
            attachmentId: 'attachment_1',
            contextId: captured.itemId,
        });
        expect(attached.status).toBe('attached');
        if (attached.status !== 'attached') return;

        const removed = removeBrowserContextComposerAttachment(attached.state, {
            attachmentId: 'attachment_1',
        });

        expect(selectBrowserContextComposerAttachments(removed)).toEqual([]);
        expect(removed.itemsById[captured.itemId]).toBeDefined();
        expect(removeBrowserContextComposerAttachment(removed, { attachmentId: 'missing' })).toBe(removed);
    });
});
