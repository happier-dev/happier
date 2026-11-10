import type { BrowserAdapterCapabilitiesV1} from '@happier-dev/protocol/browser/adapters/v1';
import type { BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { describe, expect, it } from 'vitest';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';

import {
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    markBrowserContextViewNavigation,
    addBrowserAnnotationElement,
    commitBrowserAnnotationDraft,
    setBrowserAnnotationDraftComment,
    startBrowserAnnotationDraft,
} from '@/sync/domains/browser/context';
import {
    buildBrowserContextMessageMetaOverrides,
    mergeBrowserContextMessageMetaOverrides,
} from './browserContext';

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
    },
} as const;

function createAttachedContextState() {
    const captured = captureBrowserPageReference({
        state: createBrowserContextState(),
        browserContextEnabled: true,
        contextCapabilities,
        adapterCapabilities,
        viewId: 'view_1',
        target,
        page: {
            url: 'https://preview.localhost.test/dashboard',
            title: 'Dashboard',
            navigationGeneration: 2,
            capturedAtMs: 4_000,
        },
    });

    expect(captured.status).toBe('captured');
    if (captured.status !== 'captured') throw new Error('fixture failed to capture context');

    const attached = attachBrowserContextToComposer(captured.state, {
        attachmentId: 'attachment_1',
        contextId: captured.itemId,
    });
    expect(attached.status).toBe('attached');

    return attached.state;
}

function createAttachedSecretUrlContextState() {
    const captured = captureBrowserPageReference({
        state: createBrowserContextState(),
        browserContextEnabled: true,
        contextCapabilities,
        adapterCapabilities,
        viewId: 'view_1',
        target,
        page: {
            url: 'https://preview.localhost.test/reset/tok9f8e7d6c5b4a3210ffeeddcc?previewToken=secret&publicToken=secret&token=secret&code=secret#secret',
            title: 'Dashboard',
            faviconUrl: 'https://preview.localhost.test/favicon.ico?token=secret#secret',
            navigationGeneration: 2,
            capturedAtMs: 4_000,
        },
    });

    expect(captured.status).toBe('captured');
    if (captured.status !== 'captured') throw new Error('fixture failed to capture context');

    const attached = attachBrowserContextToComposer(captured.state, {
        attachmentId: 'attachment_1',
        contextId: captured.itemId,
    });
    expect(attached.status).toBe('attached');

    return attached.state;
}

describe('buildBrowserContextMessageMetaOverrides', () => {
    it('sends one annotation marks document and element source facts through the real context envelope', () => {
        const binding = { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 1 };
        let state = startBrowserAnnotationDraft(createBrowserContextState(), {
            ...binding, nowMs: 1,
            source: { uri: 'blob:annotation', width: 100, height: 80, scale: 2 },
            capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 100, height: 80, sizeBytes: 1 },
            pageTitle: 'Checkout', pageUrl: 'https://shop.example/checkout?token=private',
        });
        const sourceLocation = { file: 'src/Checkout.tsx', line: 24, column: 8 };
        state = addBrowserAnnotationElement(state, { viewId: binding.viewId, markId: 'submit', color: 'blue',
            element: { rect: { x: 10, y: 20, width: 30, height: 40 }, label: 'Submit', selectorPath: '#submit',
                accessibleName: 'Submit', componentName: 'Checkout', sourceLocation } });
        state = setBrowserAnnotationDraftComment(state, { viewId: binding.viewId, comment: 'Describe the spacing.' });
        const document = state.annotationDraftByViewId[binding.viewId]?.document;
        const imageRef = { mediaId: 'flattened_1', mediaKind: 'image' as const, width: 100, height: 80, sizeBytes: 100 };
        const committed = commitBrowserAnnotationDraft({ ...binding, state, imageRef, adapterKind: 'localPreview', capturedAtMs: 2 });
        if (committed.status !== 'committed') throw new Error('annotation fixture failed to commit');
        const attached = attachBrowserContextToComposer(committed.state, { attachmentId: 'attachment_1', contextId: committed.itemIds[0]! });
        if (attached.status !== 'attached') throw new Error('annotation fixture failed to attach');
        const result = buildBrowserContextMessageMetaOverrides({ state: attached.state });
        if (!result.ok) throw new Error('annotation fixture failed to project');

        const payload = HappierStructuredInputV1Schema.parse(result.metaOverrides.happierStructuredInputV1).browserContext!;
        expect(payload.contexts).toHaveLength(1);
        expect(payload.contexts[0]).toMatchObject({ kind: 'browserAnnotation', imageRef, marks: document,
            elements: [{ markId: 'submit', selectorPath: '#submit', accessibleName: 'Submit', componentName: 'Checkout', sourceLocation }] });
        expect(payload.attachments[0]?.structuredBlock).toMatchObject({ kind: 'browser.annotation.v2', imageRef, marks: document });
        expect(payload.contexts[0]).not.toHaveProperty('media');
        expect(payload.contexts[0]).not.toHaveProperty('comment');
        expect(payload.attachments[0]?.structuredBlock).not.toHaveProperty('comment');
        expect(JSON.stringify(payload)).not.toContain('private');
    });

    it('builds browser context in the canonical structured-input envelope', () => {
        const result = buildBrowserContextMessageMetaOverrides({
            state: createAttachedContextState(),
        });

        expect(result).toEqual({
            ok: true,
            metaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    browserContext: {
                        contexts: [expect.objectContaining({
                            kind: 'browserPageReference',
                            targetId: 'preview_1',
                            url: 'https://preview.localhost.test/dashboard',
                            redactionLevel: 'metadataOnly',
                        })],
                        attachments: [expect.objectContaining({
                            attachmentId: 'attachment_1',
                            state: 'available',
                            requiresReconfirmBeforeSend: false,
                        })],
                    },
                },
            },
        });
    });

    it('does not project page-reference URL token paths, query or fragment values into message metadata', () => {
        const result = buildBrowserContextMessageMetaOverrides({
            state: createAttachedSecretUrlContextState(),
        });

        expect(result).toEqual({
            ok: true,
            metaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    browserContext: {
                        contexts: [expect.objectContaining({
                            kind: 'browserPageReference',
                            targetId: 'preview_1',
                            url: 'https://preview.localhost.test/reset/:redacted',
                            faviconUrl: 'https://preview.localhost.test/favicon.ico',
                            redactionLevel: 'metadataOnly',
                        })],
                        attachments: [expect.objectContaining({
                            attachmentId: 'attachment_1',
                        })],
                    },
                },
            },
        });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(JSON.stringify(result)).not.toContain('previewToken');
        expect(JSON.stringify(result)).not.toContain('publicToken');
        expect(JSON.stringify(result)).not.toContain('token=');
        expect(JSON.stringify(result)).not.toContain('code=');
        expect(JSON.stringify(result)).not.toContain('#secret');
        expect(JSON.stringify(result)).not.toContain('tok9f8e7d6c5b4a3210ffeeddcc');
    });

    it('blocks send projection when captured context is stale after navigation', () => {
        const staleState = markBrowserContextViewNavigation(createAttachedContextState(), {
            viewId: 'view_1',
            navigationGeneration: 3,
        });

        const result = buildBrowserContextMessageMetaOverrides({
            state: staleState,
        });

        expect(result).toEqual({
            ok: false,
            reasonCode: 'browser_context_navigation_stale',
            staleAttachmentIds: ['attachment_1'],
        });
    });

    it('blocks send projection when an attached context becomes policy-denied before send', () => {
        const attachedState = createAttachedContextState();
        const attachment = attachedState.attachmentsById.attachment_1;
        expect(attachment).toBeDefined();
        if (!attachment) return;
        const item = attachedState.itemsById[attachment.contextId];
        expect(item).toBeDefined();
        if (!item) return;

        const policyDeniedState = {
            ...attachedState,
            itemsById: {
                ...attachedState.itemsById,
                [item.contextId]: {
                    ...item,
                    lifecycleState: 'sensitiveOrigin',
                    redactionLevel: 'blocked',
                    disabledReason: 'Sensitive origin blocks context send.',
                },
            },
        } as const;

        const result = buildBrowserContextMessageMetaOverrides({
            state: policyDeniedState,
        });

        expect(result).toEqual({
            ok: false,
            reasonCode: 'browser_context_attachment_unavailable',
            unavailableAttachmentIds: ['attachment_1'],
        });
    });

    it('merges browser context metadata with existing message metadata owners', () => {
        const result = mergeBrowserContextMessageMetaOverrides({
            state: createAttachedContextState(),
            metaOverrides: {
                happier: {
                    kind: 'participant_message.v1',
                    payload: {
                        recipient: { kind: 'agent_team_member', memberId: 'qa' },
                    },
                },
            },
        });

        expect(result).toEqual({
            ok: true,
            metaOverrides: {
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                }),
                happierStructuredInputV1: expect.objectContaining({
                    v: 1,
                    browserContext: expect.objectContaining({
                        contexts: [expect.objectContaining({
                            kind: 'browserPageReference',
                            url: 'https://preview.localhost.test/dashboard',
                        })],
                    }),
                }),
            },
        });
    });

    it('keeps sends without attached browser context unchanged', () => {
        expect(mergeBrowserContextMessageMetaOverrides({
            state: createBrowserContextState(),
            metaOverrides: {
                happier: {
                    kind: 'participant_message.v1',
                },
            },
        })).toEqual({
            ok: true,
            metaOverrides: {
                happier: {
                    kind: 'participant_message.v1',
                },
            },
        });

        expect(mergeBrowserContextMessageMetaOverrides({
            state: createBrowserContextState(),
        })).toEqual({
            ok: true,
            metaOverrides: undefined,
        });
    });
});
