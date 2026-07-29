import type { BrowserAdapterCapabilitiesV1, BrowserContextCapabilities } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    markBrowserContextViewNavigation,
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
            url: 'https://preview.localhost.test/dashboard?previewToken=secret&publicToken=secret&token=secret&code=secret#secret',
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
    it('builds a separate browser-context metadata envelope without replacing existing message meta owners', () => {
        const result = buildBrowserContextMessageMetaOverrides({
            state: createAttachedContextState(),
        });

        expect(result).toEqual({
            ok: true,
            metaOverrides: {
                happierBrowserContext: {
                    kind: 'browser_context.v1',
                    payload: {
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

    it('does not project page-reference URL query or fragment values into message metadata', () => {
        const result = buildBrowserContextMessageMetaOverrides({
            state: createAttachedSecretUrlContextState(),
        });

        expect(result).toEqual({
            ok: true,
            metaOverrides: {
                happierBrowserContext: {
                    kind: 'browser_context.v1',
                    payload: {
                        contexts: [expect.objectContaining({
                            kind: 'browserPageReference',
                            targetId: 'preview_1',
                            url: 'https://preview.localhost.test/dashboard',
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
                happierBrowserContext: expect.objectContaining({
                    kind: 'browser_context.v1',
                    payload: expect.objectContaining({
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
