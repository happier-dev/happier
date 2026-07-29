import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

type TestImagePreviewState =
    | Readonly<{ status: 'loaded'; uri: string; error: null }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

const previewState = vi.hoisted((): { current: TestImagePreviewState } => ({
    current: {
        status: 'loaded',
        uri: 'blob:preview',
        error: null,
    },
}));
const useSessionImagePreviewSpy = vi.hoisted(() => vi.fn(() => previewState.current));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-image', () => ({
    Image: 'ExpoImage',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: useSessionImagePreviewSpy,
}));

afterEach(() => {
    useSessionImagePreviewSpy.mockClear();
    previewState.current = {
        status: 'loaded',
        uri: 'blob:preview',
        error: null,
    };
    standardCleanup();
});

describe('SessionMediaInlineImages', () => {
    it('renders public media as inert metadata without invoking a preview resolver', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const path = '.happier/uploads/generated/public.png';
        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="public"
                media={[{
                    id: 'public-image',
                    status: 'available',
                    name: 'public.png',
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {
                    throw new Error('public media must not open a file');
                }}
                fileOpenEnabled={false}
                mediaPreviewEnabled={false}
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${path}`);
        expect(tile?.type).toBe('View');
        expect(tile?.props.onPress).toBeUndefined();
        expect(useSessionImagePreviewSpy).not.toHaveBeenCalled();
    });

    it('renders available video references as accessible file-opening media tiles', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const { t } = await import('@/text');
        const onOpenPath = vi.fn();

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'recording-1',
                    mediaKind: 'video',
                    status: 'available',
                    name: 'browser-recording.webm',
                    path: '.happier/uploads/artifacts/session-1/message-1/browser-recording.webm',
                    mimeType: 'video/webm',
                    sizeBytes: 2048,
                    category: 'tool-artifact',
                    role: 'output',
                } as any]}
                onOpenPath={onOpenPath}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-video:.happier/uploads/artifacts/session-1/message-1/browser-recording.webm');

        expect(tile?.props.accessibilityRole).toBe('button');
        expect(tile?.props.accessibilityLabel).toBe(t('files.sessionMedia.toolArtifactVideoA11y', { name: 'browser-recording.webm' }));

        screen.pressByTestId('message-session-media-inline-video:.happier/uploads/artifacts/session-1/message-1/browser-recording.webm');
        expect(onOpenPath).toHaveBeenCalledWith('.happier/uploads/artifacts/session-1/message-1/browser-recording.webm');
    });

    it('renders unavailable media failure rows with translated accessible state', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const { t } = await import('@/text');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'failure-0',
                    status: 'unavailable',
                    name: 'generated.png',
                    mimeType: 'image/png',
                    category: 'generated',
                    role: 'output',
                    failureCode: 'invalid_source_file',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-image-unavailable:failure-0');

        expect(tile?.props.accessibilityRole).toBe('image');
        expect(tile?.props.accessibilityLabel).toBe(t('files.sessionMedia.unavailableImageA11y', { name: 'generated.png' }));
        expect(screen.getTextContent()).toContain(t('files.sessionMedia.previewUnavailableA11y'));
    });

    it('exposes inline image tiles as accessible translated buttons', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const { t } = await import('@/text');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-1',
                    name: 'diagram.png',
                    path: '.happier/uploads/generated/session-1/message-1/diagram.png',
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-image:.happier/uploads/generated/session-1/message-1/diagram.png');

        expect(tile?.props.accessibilityRole).toBe('button');
        expect(tile?.props.accessibilityLabel).toBe(t('files.sessionMedia.generatedImageA11y', { name: 'diagram.png' }));
    });

    it('fills the tile and preserves aspect ratio when expo-image reports intrinsic dimensions', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const path = '.happier/uploads/generated/session-1/message-1/wide.png';
        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-wide',
                    name: 'wide.png',
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const preview = screen.findByTestId(`message-session-media-inline-image-preview:${path}`);
        expect(preview?.type).toBe('ExpoImage');
        expect(preview?.props.contentFit).toBe('contain');
        expect(preview?.props.style).toEqual({
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
        });

        await act(async () => {
            preview?.props.onLoad({
                cacheType: 'none',
                source: {
                    url: 'blob:preview',
                    width: 1600,
                    height: 900,
                    mediaType: 'image/png',
                },
            });
        });

        const tile = screen.findByTestId(`message-session-media-inline-image:${path}`);
        expect(tile?.props.style).toContainEqual({ width: 220, height: 124 });
    });

    it('opens available previews using indexes that skip unavailable failure rows', async () => {
        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const { Modal } = await import('@/modal');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'failure-0',
                    status: 'unavailable',
                    name: 'missing.png',
                    category: 'generated',
                    role: 'output',
                    failureCode: 'invalid_source_file',
                }, {
                    id: 'media-1',
                    status: 'available',
                    name: 'first.png',
                    path: '.happier/uploads/generated/session-1/message-1/first.png',
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }, {
                    id: 'media-2',
                    status: 'available',
                    name: 'second.png',
                    path: '.happier/uploads/generated/session-1/message-1/second.png',
                    mimeType: 'image/png',
                    sizeBytes: 43,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        screen.pressByTestId('message-session-media-inline-image:.happier/uploads/generated/session-1/message-1/first.png');

        expect(Modal.show).toHaveBeenCalledTimes(1);
        const [config] = vi.mocked(Modal.show).mock.calls[0] ?? [];
        expect(config?.props?.images).toHaveLength(2);
        expect(config?.props?.initialIndex).toBe(0);
    });

    it('exposes a translated unavailable hint when an inline image preview is missing', async () => {
        previewState.current = {
            status: 'error',
            uri: null,
            error: 'not found',
        };

        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const { t } = await import('@/text');

        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-1',
                    name: 'input.png',
                    path: '.happier/uploads/attachments/session-1/message-1/input.png',
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'attachment',
                    role: 'input',
                }]}
                onOpenPath={() => {}}
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId('message-session-media-inline-image:.happier/uploads/attachments/session-1/message-1/input.png');

        expect(tile?.props.accessibilityRole).toBe('button');
        expect(tile?.props.accessibilityLabel).toBeTruthy();
        expect(tile?.props.accessibilityHint).toBe(t('files.sessionMedia.previewUnavailableA11y'));
    });

    it('does not announce an unavailable image as actionable when file opening is unavailable', async () => {
        previewState.current = {
            status: 'error',
            uri: null,
            error: 'not found',
        };

        const { SessionMediaInlineImages } = await import('./SessionMediaInlineImages');
        const path = '.happier/uploads/generated/session-1/message-1/missing.png';
        const screen = await renderScreen(
            <SessionMediaInlineImages
                sessionId="s1"
                media={[{
                    id: 'media-missing',
                    name: 'missing.png',
                    path,
                    mimeType: 'image/png',
                    sizeBytes: 42,
                    category: 'generated',
                    role: 'output',
                }]}
                onOpenPath={() => {
                    throw new Error('file opening is unavailable');
                }}
                fileOpenEnabled={false}
                mediaPreviewEnabled
            />,
        );

        const tile = screen.findByTestId(`message-session-media-inline-image:${path}`);
        expect(tile?.props.accessibilityRole).toBe('image');
        expect(tile?.props.onPress).toBeUndefined();
    });
});
