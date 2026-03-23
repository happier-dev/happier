import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

const actEnvironmentGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

type PreviewState =
    | { status: 'loaded'; uri: string; svgXml: string | null; error: null }
    | { status: 'error'; uri: null; svgXml: null; error: string };

const previewState = vi.hoisted(() => ({
    value: { status: 'loaded', uri: 'data:image/png;base64,.happier/uploads/messages/m1/file.png', svgXml: null, error: null } as PreviewState,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 900, height: 700 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: (input: { enabled: boolean; filePath: string }) => {
        if (!input.enabled) {
            return { status: 'disabled', uri: null, error: null };
        }
        if (previewState.value.status === 'error') {
            return previewState.value;
        }
        return { ...previewState.value, uri: `data:image/png;base64,${input.filePath}` };
    },
}));

describe('AttachmentImagePreviewModal', () => {
    const previousActEnvironment = actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT;

    beforeEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = true;
        previewState.value = { status: 'loaded', uri: 'data:image/png;base64,reset', svgXml: null, error: null };
    });

    afterEach(() => {
        actEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    });

    it('renders the current direct image with inline width and height sizing for expo-image', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            images={[
                { kind: 'direct', uri: 'blob:first', title: 'first.png' },
            ]}
            initialIndex={0}
        />);

        const image = screen.findByType('Image');
        expect(image.props.source).toEqual({ uri: 'blob:first' });
        expect(Array.isArray(image.props.style)).toBe(true);
        expect(image.props.style[0]).toEqual({ width: '100%', height: '100%' });
    });

    it('hides navigation until hover on web and omits the footer index', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            images={[
                { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                { kind: 'direct', uri: 'blob:second', title: 'second.png' },
            ]}
            initialIndex={0}
        />);

        expect(screen.findAllByTestId('attachment-image-preview-previous')).toHaveLength(0);
        expect(screen.findAllByTestId('attachment-image-preview-next')).toHaveLength(0);
        expect(screen.findAllByTestId('attachment-image-preview-index')).toHaveLength(0);

        act(() => {
            invokeTestInstanceHandler(screen.findByTestId('attachment-image-preview-surface'), 'onHoverIn', undefined, 'attachment-image-preview-surface');
        });

        expect(screen.findAllByTestId('attachment-image-preview-previous')).toHaveLength(1);
        expect(screen.findAllByTestId('attachment-image-preview-next')).toHaveLength(1);
    });

    it('navigates between direct images after hover', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            images={[
                { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                { kind: 'direct', uri: 'blob:second', title: 'second.png' },
            ]}
            initialIndex={0}
        />);

        act(() => {
            invokeTestInstanceHandler(screen.findByTestId('attachment-image-preview-surface'), 'onHoverIn', undefined, 'attachment-image-preview-surface');
        });

        await screen.pressByTestIdAsync('attachment-image-preview-next');

        expect(screen.findByType('Image').props.source).toEqual({ uri: 'blob:second' });
        expect(screen.findByTestId('attachment-image-preview-title')?.props.children).toBe('second.png');
    });

    it('renders session-backed images through the shared session preview hook', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            images={[
                {
                    kind: 'session-image',
                    title: 'from-transcript.png',
                    sessionId: 's1',
                    filePath: '.happier/uploads/messages/m1/file.png',
                    mimeType: 'image/png',
                    sizeBytes: 10,
                    cacheKey: 'hash',
                },
            ]}
            initialIndex={0}
        />);

        expect(screen.findByType('Image').props.source).toEqual({
            uri: 'data:image/png;base64,.happier/uploads/messages/m1/file.png',
        });
    });

    it('shows a generic localized error instead of raw preview details', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        previewState.value = { status: 'error', uri: null, svgXml: null, error: 'internal disk path leaked' };

        const screen = await renderScreen(<AttachmentImagePreviewModal
            onClose={() => {}}
            images={[
                {
                    kind: 'session-image',
                    title: 'broken.png',
                    sessionId: 's1',
                    filePath: '.happier/uploads/messages/m1/file.png',
                    mimeType: 'image/png',
                    sizeBytes: 10,
                    cacheKey: 'hash',
                },
            ]}
            initialIndex={0}
        />);

        const textNodes = screen.findAll((node) => node.props?.children === 'common.error');
        expect(textNodes.length).toBeGreaterThan(0);
        expect(() => screen.find((node) => node.props?.children === 'internal disk path leaked')).toThrow();
    });
});
