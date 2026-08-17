import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAdapterCapabilitiesV1, BrowserContextCapabilities } from '@happier-dev/protocol';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';
import {
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    type BrowserContextState,
} from '@/sync/domains/browser/context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({}),
        },
    });
});

vi.mock('./buildSessionAgentInputActionChips', () => ({
    buildSessionAgentInputActionChips: () => [],
}));

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
    t: (key: string) => key,
}));

type HookWithBrowserContext = (params: Readonly<{
    sessionId: string;
    attachmentsUploadsEnabled: boolean;
    isReadOnly: boolean;
    isUploadingAttachments: boolean;
    onPickAttachmentFile: () => void;
    onPickAttachmentImage: () => void;
    onPasteAttachmentImage?: () => void;
    onAppendLinkedPath: (path: string) => void;
    reviewCommentsEnabled: boolean;
    reviewScope: null;
    reviewCommentDrafts: readonly [];
    defaultBackendTarget?: null;
    defaultBackendId: null;
    instructionsText: string;
    browserContext?: Readonly<{
        state: BrowserContextState;
        onAttachPageReference?: () => void;
        onRemoveAttachment?: (attachmentId: string) => void;
        disabledReason?: string | null;
    }> | null;
}>) => Readonly<{
    actionChips: readonly AgentInputExtraActionChip[];
    attachmentRowItems: readonly AgentInputAttachmentsRowItem[];
}>;

describe('useSessionAgentInputExtraActionChips browser context integration', () => {
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

    function createAttachedBrowserContextState(): BrowserContextState {
        const captured = captureBrowserPageReference({
            state: createBrowserContextState(),
            browserContextEnabled: true,
            contextCapabilities,
            adapterCapabilities,
            viewId: 'view_1',
            target: {
                kind: 'localServicePreview',
                targetId: 'preview_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                display: {
                    title: 'Kitchen Sink',
                    addressLabel: 'localhost:5173',
                },
            },
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

    it('does not show an empty browser-context chip before context is attached', async () => {
        const { useSessionAgentInputExtraActionChips } = await import('./useSessionAgentInputExtraActionChips');
        const hook = useSessionAgentInputExtraActionChips as unknown as HookWithBrowserContext;
        let presentation: ReturnType<HookWithBrowserContext> | undefined;

        function Probe() {
            presentation = hook({
                sessionId: 'session-1',
                attachmentsUploadsEnabled: false,
                isReadOnly: false,
                isUploadingAttachments: false,
                onPickAttachmentFile: () => {},
                onPickAttachmentImage: () => {},
                onAppendLinkedPath: () => {},
                reviewCommentsEnabled: false,
                reviewScope: null,
                reviewCommentDrafts: [],
                defaultBackendTarget: null,
                defaultBackendId: null,
                instructionsText: '',
                browserContext: {
                    state: createBrowserContextState(),
                    onAttachPageReference: vi.fn(),
                },
            });
            return null;
        }

        await renderScreen(<Probe />);

        expect(presentation?.actionChips.some((chip) => chip.key === 'browser-context')).toBe(false);
        expect(presentation?.attachmentRowItems).toEqual([]);
    });

    it('adds the browser-context chip through the existing session composer extra-chip pipeline when context is attached', async () => {
        const { useSessionAgentInputExtraActionChips } = await import('./useSessionAgentInputExtraActionChips');
        const hook = useSessionAgentInputExtraActionChips as unknown as HookWithBrowserContext;
        let presentation: ReturnType<HookWithBrowserContext> | undefined;

        function Probe() {
            presentation = hook({
                sessionId: 'session-1',
                attachmentsUploadsEnabled: false,
                isReadOnly: false,
                isUploadingAttachments: false,
                onPickAttachmentFile: () => {},
                onPickAttachmentImage: () => {},
                onAppendLinkedPath: () => {},
                reviewCommentsEnabled: false,
                reviewScope: null,
                reviewCommentDrafts: [],
                defaultBackendTarget: null,
                defaultBackendId: null,
                instructionsText: '',
                browserContext: {
                    state: createAttachedBrowserContextState(),
                    onAttachPageReference: vi.fn(),
                },
            });
            return null;
        }

        await renderScreen(<Probe />);

        const browserContextChip = presentation?.actionChips.find((chip) => chip.key === 'browser-context');
        expect(browserContextChip?.controlId).toBe('shortcuts');
        expect('composerAttachmentBadge' in (browserContextChip ?? {})).toBe(false);
        const browserContextRowItem = presentation?.attachmentRowItems.find((item) => item.key === 'browser-context');
        expect(browserContextRowItem).toMatchObject({
            kind: 'badge',
            testID: 'agent-input-browser-context-attachment-badge',
        });

        const rendered = browserContextChip?.render({
            chipStyle: () => null,
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        }) as React.ReactElement<{ onPress?: () => void }> | undefined;

        rendered?.props.onPress?.();
    });
});
