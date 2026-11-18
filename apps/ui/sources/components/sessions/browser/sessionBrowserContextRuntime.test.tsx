import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { startBrowserAnnotationDraft } from '@/sync/domains/browser/context/annotationDraft';
import { BrowserContextCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control/reducer';
import { attachActiveBrowserPageReference, createBrowserContextState } from '@/sync/domains/browser/context';
import { createBrowserContextActionChip } from '@/components/sessions/agentInput/definitions/createBrowserContextActionChip';
import {
    SessionBrowserContextRuntimeProvider,
    useSessionBrowserContextRuntime,
    useSessionBrowserContextRuntimeContext,
} from './sessionBrowserContextRuntime';

// This hook test never performs a daemon file transfer.
vi.mock('@/sync/domains/transfers/ops/uploadSessionAttachment', () => ({ sessionAttachmentsUploadFile: vi.fn() }));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => {
        if (!params) return key;
        return `${key}:${Object.values(params).join(':')}`;
    } });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function RuntimeProbe(): React.ReactElement {
    function Consumer(): React.ReactElement {
        const runtime = useSessionBrowserContextRuntimeContext();
        return (
            <View>
                <Pressable
                    testID="attach-page"
                    onPress={() => runtime?.browserShellContext.onAttachPageReferenceChange?.(() => {
                        runtime.browserShellContext.onStateChange({
                            ...runtime.browserShellContext.state,
                            itemsById: {
                                context_1: {
                                    v: 1,
                                    contextId: 'context_1',
                                    kind: 'browserPageReference',
                                    sourceViewId: 'view_1',
                                    sourceAdapterKind: 'localPreview',
                                    fidelity: 'nativeCallback',
                                    capturedAtMs: 1_000,
                                    navigationGeneration: 1,
                                    lifecycleState: 'available',
                                    redactionLevel: 'metadataOnly',
                                    url: 'https://preview.happier.test/dashboard',
                                    title: 'Preview Dashboard',
                                },
                            },
                            itemOrder: ['context_1'],
                            attachmentsById: {
                                attachment_1: {
                                    attachmentId: 'attachment_1',
                                    contextId: 'context_1',
                                },
                            },
                            attachmentOrder: ['attachment_1'],
                            navigationGenerationByViewId: { view_1: 1 },
                            activeAnnotationByViewId: {},
                            annotationDraftByViewId: {},
                        });
                    })}
                />
                <Pressable
                    testID="composer-attach"
                    onPress={() => runtime?.composerContext.onAttachPageReference?.()}
                />
                <Pressable
                    testID="remove-context"
                    onPress={() => runtime?.composerContext.onRemoveAttachment?.('attachment_1')}
                />
                <Text testID="attachment-count">{runtime?.state.attachmentOrder.length ?? -1}</Text>
            </View>
        );
    }

    const runtime = useSessionBrowserContextRuntime({ enabled: true, nowMs: () => 1_000 });
    return (
        <SessionBrowserContextRuntimeProvider runtime={runtime}>
            <Consumer />
        </SessionBrowserContextRuntimeProvider>
    );
}

/** A browser page attached the way the Session's browser pane attaches it. */
function buildAttachedBrowserPageState() {
    const url = 'https://storefront.example.test/checkout';
    const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
        kind: 'sessionCreated', eventId: 'browser-session-created',
        browserSessionId: 'browser-session', profileId: 'browser-profile', occurredAt: 1_000,
    }), {
        kind: 'viewOpened', eventId: 'browser-page-opened',
        browserSessionId: 'browser-session', viewId: 'browser-page',
        target: { kind: 'externalUrl', targetId: 'storefront', url,
            display: { title: 'Storefront · Checkout', addressLabel: 'Storefront preview' } },
        platform: 'web', adapterKind: 'externalUrl', engineKind: 'webIframe', currentUrl: url,
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'],
        }),
        occurredAt: 1_000,
    });
    return attachActiveBrowserPageReference({
        state: createBrowserContextState(),
        browserContextEnabled: true,
        contextCapabilities: BrowserContextCapabilitiesSchema.parse({
            enabled: true, available: true,
            supportedContextKinds: ['browserPageReference'], supportedAdapterKinds: ['externalUrl'],
        }),
        view: state.viewsById['browser-page'] ?? null,
        capturedAtMs: 1_000,
    }).state;
}

/** Attaches one page after the Session's own mount-time reset, like the browser pane does. */
function AttachedBrowserPage(): null {
    const runtime = useSessionBrowserContextRuntimeContext();
    const [contextState] = React.useState(buildAttachedBrowserPageState);
    const onStateChange = runtime?.browserShellContext.onStateChange;
    const onAttachPageReferenceChange = runtime?.browserShellContext.onAttachPageReferenceChange;
    React.useEffect(() => {
        if (!onStateChange || !onAttachPageReferenceChange) return;
        let mounted = true;
        void Promise.resolve().then(() => {
            if (!mounted) return;
            onStateChange(contextState);
            onAttachPageReferenceChange(() => onStateChange(contextState));
        });
        return () => {
            mounted = false;
            onAttachPageReferenceChange(null);
        };
    }, [contextState, onAttachPageReferenceChange, onStateChange]);
    return null;
}

describe('session browser context runtime', () => {
    it('stages a real attached browser page through the mounted runtime and removes it through the composer', async () => {
        function StageProbe() {
            const runtime = useSessionBrowserContextRuntime({ enabled: true });
            const presentation = runtime ? createBrowserContextActionChip(runtime.composerContext) : null;
            return <SessionBrowserContextRuntimeProvider runtime={runtime}>
                <AttachedBrowserPage />
                <Text testID="staged-browser-page">{presentation?.attachmentRowItem?.label ?? ''}</Text>
                <Pressable testID="remove-staged-page" onPress={presentation?.attachmentRowItem?.onRemove} />
            </SessionBrowserContextRuntimeProvider>;
        }
        const screen = await renderScreen(<StageProbe />);
        expect(screen.findByTestId('staged-browser-page')?.props.children).toContain('Storefront · Checkout');
        await screen.pressByTestIdAsync('remove-staged-page');
        expect(screen.findByTestId('staged-browser-page')?.props.children).toBe('');
    });
    it('refuses annotation delivery without the invoking Session Account scope', async () => {
        let outcome: unknown;
        function UnboundSession(): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 'session_1' });
            return <Pressable testID="commit-unbound-annotation" onPress={async () => {
                outcome = await runtime?.browserShellContext.commitAnnotation?.({ png: new Uint8Array([1]),
                    original: { uri: 'data:image/png;base64,AQ==', width: 40, height: 30, scale: 1 },
                    width: 40, height: 30, document: { v: 1, image: { width: 40, height: 30, scale: 1 }, marks: [] },
                    comment: 'Fix this', annotationId: 'annotation_1' });
            }} />;
        }
        const screen = await renderScreen(<UnboundSession />);
        await screen.pressByTestIdAsync('commit-unbound-annotation');
        expect(outcome).toEqual({ ok: false, reason: 'annotation.targetUnavailable' });
    });
    it('exposes committed state immediately to consecutive actions before a React render', async () => {
        function ConsecutiveActionProbe(): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true });
            return <View>
                <Pressable testID="consecutive-actions" onPress={() => {
                    if (!runtime) return;
                    const context = runtime.browserShellContext;
                    const read = () => context.readState?.() ?? context.state;
                    context.onStateChange({ ...read(), navigationGenerationByViewId: { view_1: 1 } });
                    context.onStateChange({ ...read(), navigationGenerationByViewId: { ...read().navigationGenerationByViewId, view_2: 2 } });
                }} />
                <Text testID="generations">{JSON.stringify(runtime?.state.navigationGenerationByViewId)}</Text>
            </View>;
        }
        const screen = await renderScreen(<ConsecutiveActionProbe />);
        await screen.pressByTestIdAsync('consecutive-actions');
        expect(screen.findByTestId('generations')?.props.children).toBe(JSON.stringify({ view_1: 1, view_2: 2 }));
    });

    it('shares one context state between browser attachment and composer removal', async () => {
        const screen = await renderScreen(<RuntimeProbe />);

        expect(screen.findByTestId('attachment-count')?.props.children).toBe(0);

        await screen.pressByTestIdAsync('attach-page');
        await screen.pressByTestIdAsync('composer-attach');

        expect(screen.findByTestId('attachment-count')?.props.children).toBe(1);

        await screen.pressByTestIdAsync('remove-context');

        expect(screen.findByTestId('attachment-count')?.props.children).toBe(0);
    });

    it('resets context state when the runtime scope changes', async () => {
        const dispose = vi.fn();
        function ScopedRuntimeProbe(props: Readonly<{ scopeKey: string }>): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true, scopeKey: props.scopeKey });
            return (
                <View>
                    <Pressable
                        testID="scope-attach"
                        onPress={() => runtime?.browserShellContext.onStateChange(startBrowserAnnotationDraft({
                            ...runtime.browserShellContext.state,
                            attachmentsById: {
                                attachment_1: {
                                    attachmentId: 'attachment_1',
                                    contextId: 'context_1',
                                },
                            },
                            attachmentOrder: ['attachment_1'],
                        }, { browserSessionId: 'browser_1', viewId: 'view_1', navigationGeneration: 1, nowMs: 1000,
                            source: { uri: 'blob:frozen', width: 40, height: 30, scale: 1 },
                            capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 40, height: 30, sizeBytes: 1 }, dispose }))}
                    />
                    <Text testID="scope-attachment-count">{runtime?.state.attachmentOrder.length ?? -1}</Text>
                </View>
            );
        }

        const screen = await renderScreen(<ScopedRuntimeProbe scopeKey="session_1" />);

        await screen.pressByTestIdAsync('scope-attach');

        expect(screen.findByTestId('scope-attachment-count')?.props.children).toBe(1);

        await screen.update(<ScopedRuntimeProbe scopeKey="session_2" />);

        expect(screen.findByTestId('scope-attachment-count')?.props.children).toBe(0);
        expect(dispose).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('scope-attach');
        await screen.unmount();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('passes annotation capture capability from the session host into browser shell context', async () => {
        function AnnotationProviderProbe(): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({
                enabled: true,
                attachmentsUploadsEnabled: true,
                annotationCaptureProvider: {
                    available: true,
                    captureViewport: async () => ({
                        status: 'captured',
                        source: { uri: 'data:image/png;base64,AQ==', width: 100, height: 100, scale: 1 },
                        capture: {
                            mediaId: 'media_session_provider',
                            mediaKind: 'image',
                            width: 100,
                            height: 100,
                            sizeBytes: 10_000,
                        },
                    }),
                },
            });

            return (
                <View>
                    <Text testID="annotation-provider-available">
                        {runtime?.browserShellContext.annotationCaptureProvider?.available === true ? 'yes' : 'no'}
                    </Text>
                    <Text testID="annotation-kind-supported">
                        {runtime?.browserShellContext.contextCapabilities.supportedContextKinds.includes('browserAnnotation') ? 'yes' : 'no'}
                    </Text>
                    <Text testID="annotation-uploads-enabled">
                        {runtime?.browserShellContext.attachmentsUploadsEnabled === true ? 'yes' : 'no'}
                    </Text>
                </View>
            );
        }

        const screen = await renderScreen(<AnnotationProviderProbe />);

        expect(screen.findByTestId('annotation-provider-available')?.props.children).toBe('yes');
        expect(screen.findByTestId('annotation-kind-supported')?.props.children).toBe('yes');
        expect(screen.findByTestId('annotation-uploads-enabled')?.props.children).toBe('yes');
    });

});
