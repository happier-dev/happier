import type {
    BrowserAdapterCapabilitiesV1,
    BrowserContextCapabilities,
    BrowserDiagnosticsElementPickerResultV1,
} from '@happier-dev/protocol';
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

    it('fails closed with typed unavailable state when browser.context is disabled', () => {
        const result = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: false,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target,
            page: {
                url: 'https://preview.localhost.test/dashboard',
                navigationGeneration: 1,
                capturedAtMs: 3_000,
            },
        });

        if (result.status !== 'unavailable') throw new Error('expected context capture to be unavailable');
        expect(result.reason.lifecycleState).toBe('policyDenied');
        expect(result.reason.reasonCode).toBe('browser_context_disabled');
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

    it('allows screenshot context availability when the attachments.uploads gate is enabled', () => {
        const reason = resolveBrowserContextKindAvailability({
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
                contextKinds: ['browserScreenshot'],
            },
            kind: 'browserScreenshot',
        });

        expect(reason).toBeNull();
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
            text: '  selected text with secret-looking tail  ',
        });

        if (selected.status !== 'captured') throw new Error('expected selected text capture to succeed');
        expect(selected.state.itemsById[selected.itemId]).toMatchObject({
            kind: 'browserTextSelection',
            text: 'selected tex',
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
            summary: 'main button input section article footer',
        });

        if (domSummary.status !== 'captured') throw new Error('expected DOM summary capture to succeed');
        expect(domSummary.state.itemsById[domSummary.itemId]).toMatchObject({
            kind: 'browserDomSnapshotSummary',
            summary: 'main button input sectio',
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

    it('requires browser diagnostics for diagnostics-derived context summaries', async () => {
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

        expect(result).toMatchObject({
            status: 'unavailable',
            reason: {
                lifecycleState: 'policyDenied',
                reasonCode: 'browser_context_diagnostics_disabled',
            },
        });
        expect(result.state.itemsById).toEqual({});

        const missingGate = captureBrowserSummaryContext({
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

        expect(missingGate).toMatchObject({
            status: 'unavailable',
            reason: {
                lifecycleState: 'policyDenied',
                reasonCode: 'browser_context_diagnostics_disabled',
            },
        });
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

    it('captures and attaches a media-backed browser annotation tied to the source navigation generation', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.startBrowserAnnotationMode).toBeTypeOf('function');
        expect(module.captureBrowserAnnotation).toBeTypeOf('function');
        expect(module.updateBrowserAnnotationComment).toBeTypeOf('function');
        const startBrowserAnnotationMode = module.startBrowserAnnotationMode as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Readonly<{
                browserContextEnabled: boolean;
                attachmentsUploadsEnabled: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                browserSessionId: string;
                viewId: string;
                navigationGeneration: number;
                startedAtMs: number;
            }>,
        ) => { status: 'started'; state: ReturnType<typeof createBrowserContextState> } | { status: 'unavailable'; state: ReturnType<typeof createBrowserContextState> };
        const captureBrowserAnnotation = module.captureBrowserAnnotation as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                attachmentsUploadsEnabled: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                browserSessionId: string;
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
                target: {
                    kind: 'region';
                    rect: { x: number; y: number; width: number; height: number };
                };
                comment?: string;
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;
        const updateBrowserAnnotationComment = module.updateBrowserAnnotationComment as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Readonly<{ contextId: string; comment: string }>,
        ) => {
            status: 'updated';
            state: ReturnType<typeof createBrowserContextState>;
        } | {
            status: 'unavailable';
            state: ReturnType<typeof createBrowserContextState>;
        };
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserAnnotation'],
            screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
                maxBytes: 5_000_000,
            },
        } satisfies BrowserContextCapabilities;
        const annotationAdapter = {
            ...adapterCapabilities,
            diagnosticsFidelityByFamily: {
                screenshot: 'injectedPage',
            },
            contextKinds: ['browserAnnotation'],
        } satisfies BrowserAdapterCapabilitiesV1;

        const started = startBrowserAnnotationMode(createBrowserContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            startedAtMs: 4_600,
        });

        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const captured = captureBrowserAnnotation({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            capturedAtMs: 4_700,
            media: {
                mediaId: 'media_annotation_1',
                mediaKind: 'image',
                width: 1280,
                height: 720,
                sizeBytes: 300_000,
            },
            target: {
                kind: 'region',
                rect: { x: 20, y: 40, width: 240, height: 96 },
            },
            comment: '  CTA should align with the card edge.  ',
        });

        if (captured.status !== 'captured') throw new Error('expected annotation capture to succeed');
        const withComment = updateBrowserAnnotationComment(captured.state, {
            contextId: captured.itemId,
            comment: ' Updated comment for the selected region. ',
        });
        expect(withComment.status).toBe('updated');
        if (withComment.status !== 'updated') return;
        const attached = attachBrowserContextToComposer(withComment.state, {
            attachmentId: 'annotation_attachment_1',
            contextId: captured.itemId,
        });
        expect(attached.status).toBe('attached');
        if (attached.status !== 'attached') return;

        const item = attached.state.itemsById[captured.itemId];
        expect(item).toMatchObject({
            kind: 'browserAnnotation',
            browserSessionId: 'browser_session_1',
            sourceViewId: 'view_1',
            sourceAdapterKind: 'localPreview',
            navigationGeneration: 7,
            lifecycleState: 'available',
            redactionLevel: 'metadataOnly',
            fidelity: 'injectedPage',
            media: { mediaId: 'media_annotation_1' },
            target: {
                kind: 'region',
                rect: { width: 240, height: 96 },
            },
            comment: 'Updated comment for the selected region.',
        });
        expect(JSON.stringify(item)).not.toContain('inlineBytes');

        const navigated = markBrowserContextViewNavigation(attached.state, {
            viewId: 'view_1',
            navigationGeneration: 8,
        });
        expect(selectBrowserContextComposerAttachments(navigated)).toEqual([
            expect.objectContaining({
                attachmentId: 'annotation_attachment_1',
                contextId: captured.itemId,
                capturedNavigationGeneration: 7,
                currentNavigationGeneration: 8,
                state: 'navigationStale',
                requiresReconfirmBeforeSend: true,
            }),
        ]);
    });

    it('captures annotation style intent and a normalized vector stroke as metadata-only context', async () => {
        const module = await import('./state') as Record<string, unknown>;
        const startBrowserAnnotationMode = module.startBrowserAnnotationMode as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Record<string, unknown>,
        ) => { status: 'started'; state: ReturnType<typeof createBrowserContextState> } | { status: 'unavailable'; state: ReturnType<typeof createBrowserContextState> };
        const captureBrowserAnnotation = module.captureBrowserAnnotation as (
            input: Record<string, unknown>,
        ) => ReturnType<typeof captureBrowserPageReference>;
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserAnnotation'],
            screenshot: { supported: true, requiresAttachmentUploads: true, maxBytes: 5_000_000 },
        } satisfies BrowserContextCapabilities;
        const annotationAdapter = {
            ...adapterCapabilities,
            diagnosticsFidelityByFamily: { screenshot: 'injectedPage' },
            contextKinds: ['browserAnnotation'],
        } satisfies BrowserAdapterCapabilitiesV1;

        const started = startBrowserAnnotationMode(createBrowserContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 3,
            startedAtMs: 1_000,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const captured = captureBrowserAnnotation({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 3,
            capturedAtMs: 1_100,
            media: { mediaId: 'media_annotation_styled', mediaKind: 'image', width: 800, height: 600, sizeBytes: 120_000 },
            target: { kind: 'region', rect: { x: 10, y: 20, width: 100, height: 80 } },
            styleIntent: 'highlight',
            stroke: { shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 }] },
        });
        if (captured.status !== 'captured') throw new Error('expected styled annotation capture to succeed');
        const item = captured.state.itemsById[captured.itemId];
        expect(item).toMatchObject({
            kind: 'browserAnnotation',
            styleIntent: 'highlight',
            stroke: { shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 }] },
        });
    });

    it('updates an existing annotation item stroke and style intent in place', async () => {
        const module = await import('./state') as Record<string, unknown>;
        const startBrowserAnnotationMode = module.startBrowserAnnotationMode as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Record<string, unknown>,
        ) => { status: 'started'; state: ReturnType<typeof createBrowserContextState> } | { status: 'unavailable'; state: ReturnType<typeof createBrowserContextState> };
        const captureBrowserAnnotation = module.captureBrowserAnnotation as (
            input: Record<string, unknown>,
        ) => ReturnType<typeof captureBrowserPageReference>;
        expect(module.updateBrowserAnnotationStroke).toBeTypeOf('function');
        expect(module.updateBrowserAnnotationStyleIntent).toBeTypeOf('function');
        const updateBrowserAnnotationStroke = module.updateBrowserAnnotationStroke as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Record<string, unknown>,
        ) => { status: 'updated'; state: ReturnType<typeof createBrowserContextState> } | { status: 'unavailable'; state: ReturnType<typeof createBrowserContextState> };
        const updateBrowserAnnotationStyleIntent = module.updateBrowserAnnotationStyleIntent as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Record<string, unknown>,
        ) => { status: 'updated'; state: ReturnType<typeof createBrowserContextState> } | { status: 'unavailable'; state: ReturnType<typeof createBrowserContextState> };
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserAnnotation'],
            screenshot: { supported: true, requiresAttachmentUploads: true, maxBytes: 5_000_000 },
        } satisfies BrowserContextCapabilities;
        const annotationAdapter = {
            ...adapterCapabilities,
            diagnosticsFidelityByFamily: { screenshot: 'injectedPage' },
            contextKinds: ['browserAnnotation'],
        } satisfies BrowserAdapterCapabilitiesV1;
        const started = startBrowserAnnotationMode(createBrowserContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            startedAtMs: 500,
        });
        if (started.status !== 'started') throw new Error('expected annotation mode start');
        const captured = captureBrowserAnnotation({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 600,
            media: { mediaId: 'media_a', mediaKind: 'image', width: 400, height: 300, sizeBytes: 50_000 },
            target: { kind: 'region', rect: { x: 0, y: 0, width: 50, height: 50 } },
        });
        if (captured.status !== 'captured') throw new Error('expected styled capture');

        const withStroke = updateBrowserAnnotationStroke(captured.state, {
            contextId: captured.itemId,
            stroke: { shape: 'arrow', points: [{ x: 0.2, y: 0.3 }, { x: 0.7, y: 0.8 }] },
        });
        expect(withStroke.status).toBe('updated');
        if (withStroke.status !== 'updated') return;
        const withIntent = updateBrowserAnnotationStyleIntent(withStroke.state, {
            contextId: captured.itemId,
            styleIntent: 'redaction',
        });
        expect(withIntent.status).toBe('updated');
        if (withIntent.status !== 'updated') return;
        expect(withIntent.state.itemsById[captured.itemId]).toMatchObject({
            kind: 'browserAnnotation',
            styleIntent: 'redaction',
            stroke: { shape: 'arrow', points: [{ x: 0.2, y: 0.3 }, { x: 0.7, y: 0.8 }] },
        });

        const missing = updateBrowserAnnotationStroke(withIntent.state, {
            contextId: 'unknown_context',
            stroke: { shape: 'line', points: [{ x: 0, y: 0 }] },
        });
        expect(missing.status).toBe('unavailable');
    });

    it('fails closed when annotation capture is attempted after navigation changes', async () => {
        const module = await import('./state') as Record<string, unknown>;
        expect(module.startBrowserAnnotationMode).toBeTypeOf('function');
        expect(module.captureBrowserAnnotation).toBeTypeOf('function');
        const startBrowserAnnotationMode = module.startBrowserAnnotationMode as (
            state: ReturnType<typeof createBrowserContextState>,
            input: Readonly<{
                browserContextEnabled: boolean;
                attachmentsUploadsEnabled: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                browserSessionId: string;
                viewId: string;
                navigationGeneration: number;
                startedAtMs: number;
            }>,
        ) => { status: 'started'; state: ReturnType<typeof createBrowserContextState> } | { status: 'unavailable'; state: ReturnType<typeof createBrowserContextState> };
        const captureBrowserAnnotation = module.captureBrowserAnnotation as (
            input: Readonly<{
                state: ReturnType<typeof createBrowserContextState>;
                browserContextEnabled: boolean;
                attachmentsUploadsEnabled: boolean;
                contextCapabilities: BrowserContextCapabilities;
                adapterCapabilities: BrowserAdapterCapabilitiesV1;
                browserSessionId: string;
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
                target: {
                    kind: 'region';
                    rect: { x: number; y: number; width: number; height: number };
                };
            }>,
        ) => ReturnType<typeof captureBrowserPageReference>;
        const annotationCapabilities = {
            ...contextCapabilities,
            supportedContextKinds: ['browserAnnotation'],
            screenshot: {
                supported: true,
                requiresAttachmentUploads: true,
            },
        } satisfies BrowserContextCapabilities;
        const annotationAdapter = {
            ...adapterCapabilities,
            diagnosticsFidelityByFamily: {
                screenshot: 'injectedPage',
            },
            contextKinds: ['browserAnnotation'],
        } satisfies BrowserAdapterCapabilitiesV1;
        const started = startBrowserAnnotationMode(createBrowserContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            startedAtMs: 4_600,
        });

        expect(started.status).toBe('started');
        if (started.status !== 'started') return;

        const result = captureBrowserAnnotation({
            state: started.state,
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationCapabilities,
            adapterCapabilities: annotationAdapter,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 8,
            capturedAtMs: 4_700,
            media: {
                mediaId: 'media_annotation_1',
                mediaKind: 'image',
                width: 1280,
                height: 720,
                sizeBytes: 300_000,
            },
            target: {
                kind: 'region',
                rect: { x: 20, y: 40, width: 240, height: 96 },
            },
        });

        expect(result).toMatchObject({
            status: 'unavailable',
            reason: {
                lifecycleState: 'navigationStale',
                reasonCode: 'browser_context_annotation_stale',
            },
        });
        expect(result.state.itemsById).toEqual({});
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
