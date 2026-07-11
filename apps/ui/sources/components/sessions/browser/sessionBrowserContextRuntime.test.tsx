import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    SessionBrowserContextRuntimeProvider,
    useSessionBrowserContextRuntime,
    useSessionBrowserContextRuntimeContext,
} from './sessionBrowserContextRuntime';

const runtimeExecutorMock = vi.hoisted(() => ({
    createFrontDoorRuntimeActionExecutor: vi.fn(() => async () => ({
        v: 1,
        status: 'ok',
    })),
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => {
        if (!params) return key;
        return `${key}:${Object.values(params).join(':')}`;
    } });
});

vi.mock('@/theme', () => ({
    lightTheme: {
        colors: {
            feed: {
                card: {
                    background: '#fff',
                },
            },
        },
    },
    darkTheme: {
        colors: {
            feed: {
                card: {
                    background: '#000',
                },
            },
        },
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorRuntimeActionExecutor: runtimeExecutorMock.createFrontDoorRuntimeActionExecutor,
}));

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

describe('session browser context runtime', () => {
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
        function ScopedRuntimeProbe(props: Readonly<{ scopeKey: string }>): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true, scopeKey: props.scopeKey });
            return (
                <View>
                    <Pressable
                        testID="scope-attach"
                        onPress={() => runtime?.browserShellContext.onStateChange({
                            ...runtime.browserShellContext.state,
                            attachmentsById: {
                                attachment_1: {
                                    attachmentId: 'attachment_1',
                                    contextId: 'context_1',
                                },
                            },
                            attachmentOrder: ['attachment_1'],
                        })}
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
    });

    it('passes annotation capture capability from the session host into browser shell context', async () => {
        function AnnotationProviderProbe(): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({
                enabled: true,
                attachmentsUploadsEnabled: true,
                annotationCaptureProvider: {
                    available: true,
                    captureAnnotation: async (request) => ({
                        status: 'captured',
                        browserSessionId: request.browserSessionId,
                        viewId: request.viewId,
                        navigationGeneration: request.navigationGeneration,
                        media: {
                            mediaId: 'media_session_provider',
                            mediaKind: 'image',
                            width: 100,
                            height: 100,
                            sizeBytes: 10_000,
                        },
                        target: {
                            kind: 'region',
                            rect: { x: 0, y: 0, width: 100, height: 100 },
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

    it('provides the front-door runtime action executor to browser annotation chrome', async () => {
        function RuntimeActionProbe(): React.ReactElement {
            const runtime = useSessionBrowserContextRuntime({ enabled: true });
            const context = runtime?.browserShellContext as
                | (NonNullable<typeof runtime>['browserShellContext'] & Readonly<{
                    annotationRuntimeActionExecute?: unknown;
                }>)
                | undefined;

            return (
                <Text testID="annotation-runtime-executor">
                    {typeof context?.annotationRuntimeActionExecute === 'function' ? 'yes' : 'no'}
                </Text>
            );
        }

        const screen = await renderScreen(<RuntimeActionProbe />);

        expect(screen.findByTestId('annotation-runtime-executor')?.props.children).toBe('yes');
        expect(runtimeExecutorMock.createFrontDoorRuntimeActionExecutor).toHaveBeenCalled();
    });
});
