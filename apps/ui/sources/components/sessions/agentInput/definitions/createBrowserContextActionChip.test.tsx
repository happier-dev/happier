import React from 'react';
import type { BrowserAdapterCapabilitiesV1} from '@happier-dev/protocol/browser/adapters/v1';
import type { BrowserContextCapabilities } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { describe, expect, it, vi } from 'vitest';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import {
    addBrowserAnnotationElement,
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    commitBrowserAnnotationDraft,
    markBrowserContextViewNavigation,
    startBrowserAnnotationDraft,
    type BrowserContextState,
} from '@/sync/domains/browser/context';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: 'Pressable',
        View: 'View',
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        const title = typeof params?.title === 'string' ? `:${params.title}` : '';
        const count = typeof params?.count === 'string' ? `:${params.count}` : '';
        return `${key}${title}${count}`;
    },
}));

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

async function loadModule() {
    const modulePath = './createBrowserContextActionChip';
    const loaded = await import(modulePath);
    expect(loaded?.createBrowserContextActionChip).toBeTypeOf('function');
    return loaded as Readonly<{
        createBrowserContextActionChip: (params: Readonly<{
            state: BrowserContextState;
            onAttachPageReference?: () => void;
            onRemoveAttachment?: (attachmentId: string) => void;
            disabledReason?: string | null;
        }>) => {
            actionChip: {
                key: string;
                controlId?: string;
                collapsedAction?: (ctx: Readonly<{
                    tint: string;
                    dismiss: () => void;
                    blurInput: () => void;
                }>) => ActionListItem | readonly ActionListItem[];
                render: (ctx: Readonly<{
                    chipStyle: (pressed: boolean) => unknown;
                    showLabel: boolean;
                    iconColor: string;
                    textStyle: unknown;
                    countTextStyle: unknown;
                    popoverAnchorRef: React.RefObject<unknown>;
                }>) => React.ReactElement<{ onPress?: () => void; disabled?: boolean }>;
            };
            attachmentRowItem?: {
                key: string;
                label: string;
                testID?: string;
                kind: 'badge';
                onRemove?: () => void;
            };
        };
    }>;
}

function createAttachedState(): BrowserContextState {
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
    if (attached.status !== 'attached') throw new Error('fixture failed to attach context');

    return attached.state;
}

function expectSingleAction(action: ActionListItem | readonly ActionListItem[] | undefined): ActionListItem {
    expect(Array.isArray(action)).toBe(false);
    if (!action || Array.isArray(action)) throw new Error('expected one collapsed action');
    return action as ActionListItem;
}

describe('createBrowserContextActionChip', () => {
    it.each([
        { pageTitle: 'Checkout', pageUrl: 'https://shop.example/checkout?cart=private', title: 'Checkout' },
        { pageTitle: undefined, pageUrl: 'https://shop.example/checkout?cart=private', title: 'https://shop.example' },
        { pageTitle: undefined, pageUrl: 'invalid', title: 'browserContext.composer.untitledPage' },
    ])('names annotation context from its page and element count ($title)', async ({ pageTitle, pageUrl, title }) => {
        const { createBrowserContextActionChip } = await loadModule();
        const binding = { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 1 };
        let state = startBrowserAnnotationDraft(createBrowserContextState(), {
            ...binding, nowMs: 1,
            source: { uri: 'blob:annotation_fixture', width: 100, height: 100, scale: 1 },
            capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 100, height: 100, sizeBytes: 1 },
            pageTitle, pageUrl,
        });
        for (const selectorPath of ['#total', '#pay']) {
            state = addBrowserAnnotationElement(state, {
                viewId: binding.viewId, markId: selectorPath, color: 'red',
                element: { selectorPath, label: selectorPath, rect: { x: 10, y: 20, width: 30, height: 40 } },
            });
        }
        const committed = commitBrowserAnnotationDraft({
            ...binding, state, adapterKind: 'localPreview', capturedAtMs: 2,
            imageRef: { mediaId: 'image_1', mediaKind: 'image', width: 100, height: 100, sizeBytes: 100 },
        });
        if (committed.status !== 'committed') throw new Error('annotation fixture failed');
        const attached = attachBrowserContextToComposer(committed.state, {
            attachmentId: 'attachment_1', contextId: committed.itemIds[0],
        });
        if (attached.status !== 'attached') throw new Error('annotation attachment fixture failed');
        const presentation = createBrowserContextActionChip({ state: attached.state, onAttachPageReference: vi.fn() });
        expect(presentation.attachmentRowItem?.label).toBe(`browserContext.composer.attachedAnnotation:${title}:2`);
        const stale = createBrowserContextActionChip({
            state: markBrowserContextViewNavigation(attached.state, { viewId: 'view_1', navigationGeneration: 2 }),
            onAttachPageReference: vi.fn(),
        });
        expect(stale.attachmentRowItem?.label).toBe(`browserContext.composer.attachedAnnotationStale:${title}:2`);
    });

    it.each([
        { element: { componentName: 'TotalRow', accessibleName: 'Order total' }, name: 'TotalRow' },
        { element: { accessibleName: 'Order total' }, name: 'Order total' },
    ])('names the one annotated element instead of counting it ($name)', async ({ element, name }) => {
        const { createBrowserContextActionChip } = await loadModule();
        const binding = { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 1 };
        let state = startBrowserAnnotationDraft(createBrowserContextState(), {
            ...binding, nowMs: 1,
            source: { uri: 'blob:annotation_fixture', width: 100, height: 100, scale: 1 },
            capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 100, height: 100, sizeBytes: 1 },
            pageTitle: 'Checkout', pageUrl: 'https://shop.example/checkout',
        });
        state = addBrowserAnnotationElement(state, {
            viewId: binding.viewId, markId: '#total', color: 'red',
            element: { selectorPath: '#total', label: name, rect: { x: 10, y: 20, width: 30, height: 40 }, ...element },
        });
        const committed = commitBrowserAnnotationDraft({
            ...binding, state, adapterKind: 'localPreview', capturedAtMs: 2,
            imageRef: { mediaId: 'image_1', mediaKind: 'image', width: 100, height: 100, sizeBytes: 100 },
        });
        if (committed.status !== 'committed') throw new Error('annotation fixture failed');
        const attached = attachBrowserContextToComposer(committed.state, {
            attachmentId: 'attachment_1', contextId: committed.itemIds[0],
        });
        if (attached.status !== 'attached') throw new Error('annotation attachment fixture failed');
        const presentation = createBrowserContextActionChip({ state: attached.state, onAttachPageReference: vi.fn() });
        expect(presentation.attachmentRowItem?.label).toBe(`Checkout · ${name}`);
        const stale = createBrowserContextActionChip({
            state: markBrowserContextViewNavigation(attached.state, { viewId: 'view_1', navigationGeneration: 2 }),
            onAttachPageReference: vi.fn(),
        });
        expect(stale.attachmentRowItem?.label).toBe(`browserContext.composer.attachedPageStale:Checkout · ${name}`);
    });

    it('exposes an explicit attach action chip for page-reference browser context', async () => {
        const { createBrowserContextActionChip } = await loadModule();
        const onAttachPageReference = vi.fn();
        const dismiss = vi.fn();
        const presentation = createBrowserContextActionChip({
            state: createBrowserContextState(),
            onAttachPageReference,
        });
        const chip = presentation.actionChip;

        expect(chip.key).toBe('browser-context');
        expect(chip.controlId).toBe('shortcuts');

        const collapsedAction = expectSingleAction(chip.collapsedAction?.({
            tint: '#000',
            dismiss,
            blurInput: () => {},
        }));
        expect(collapsedAction.id).toBe('browser-context');
        expect(collapsedAction.disabled).toBe(false);
        collapsedAction.onPress?.();
        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(onAttachPageReference).toHaveBeenCalledTimes(1);

        const rendered = chip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        });
        expect(rendered.props.disabled).toBe(false);
        rendered.props.onPress?.();
        expect(onAttachPageReference).toHaveBeenCalledTimes(2);
    });

    it('projects an attached page reference as an independently removable row item', async () => {
        const { createBrowserContextActionChip } = await loadModule();
        const onRemoveAttachment = vi.fn();
        const presentation = createBrowserContextActionChip({
            state: createAttachedState(),
            onAttachPageReference: vi.fn(),
            onRemoveAttachment,
        });
        const chip = presentation.actionChip;

        expect('composerAttachmentBadge' in chip).toBe(false);
        expect(presentation.attachmentRowItem).toMatchObject({
            kind: 'badge',
            key: 'browser-context',
            label: 'browserContext.composer.attachedPage:Dashboard',
            testID: 'agent-input-browser-context-attachment-badge',
        });

        presentation.attachmentRowItem?.onRemove?.();
        expect(onRemoveAttachment).toHaveBeenCalledWith('attachment_1');
    });

    it('marks stale browser context visibly instead of silently sending old page state', async () => {
        const { createBrowserContextActionChip } = await loadModule();
        const staleState = markBrowserContextViewNavigation(createAttachedState(), {
            viewId: 'view_1',
            navigationGeneration: 3,
        });
        const presentation = createBrowserContextActionChip({
            state: staleState,
            onAttachPageReference: vi.fn(),
        });

        expect(presentation.attachmentRowItem?.label).toBe('browserContext.composer.attachedPageStale:Dashboard');
    });

    it('keeps the action visible but disabled when browser context is policy unavailable', async () => {
        const { createBrowserContextActionChip } = await loadModule();
        const onAttachPageReference = vi.fn();
        const presentation = createBrowserContextActionChip({
            state: createBrowserContextState(),
            onAttachPageReference,
            disabledReason: 'policyDenied',
        });
        const chip = presentation.actionChip;

        const collapsedAction = expectSingleAction(chip.collapsedAction?.({
            tint: '#000',
            dismiss: () => {},
            blurInput: () => {},
        }));
        expect(collapsedAction.disabled).toBe(true);
        collapsedAction.onPress?.();

        const rendered = chip.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        });
        expect(rendered.props.disabled).toBe(true);
        rendered.props.onPress?.();
        expect(onAttachPageReference).not.toHaveBeenCalled();
    });
});
