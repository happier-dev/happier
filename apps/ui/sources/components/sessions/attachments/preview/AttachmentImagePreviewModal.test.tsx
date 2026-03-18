import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previewState = vi.hoisted(() => ({
    value: { status: 'loaded', uri: 'data:image/png;base64,reset', svgXml: null, error: null } as
        | { status: 'loaded'; uri: string; svgXml: string | null; error: null }
        | { status: 'error'; uri: null; svgXml: null; error: string },
}));

vi.mock('react-native', async () => {
    const actual = await import('@/dev/reactNativeStub');
    return {
        ...actual,
        Platform: {
            OS: 'web',
            select: (x: any) => x?.web ?? x?.default ?? x?.ios ?? x?.android ?? null,
        },
        useWindowDimensions: () => ({ width: 900, height: 700 }),
    };
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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
    beforeEach(() => {
        previewState.value = { status: 'loaded', uri: 'data:image/png;base64,reset', svgXml: null, error: null };
    });

    it('renders the current direct image with inline width and height sizing for expo-image', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <AttachmentImagePreviewModal
                    onClose={() => {}}
                    images={[
                        { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                    ]}
                    initialIndex={0}
                />,
            );
        });

        const image = tree!.root.findByType('Image');
        expect(image.props.source).toEqual({ uri: 'blob:first' });
        expect(Array.isArray(image.props.style)).toBe(true);
        expect(image.props.style[0]).toEqual({ width: '100%', height: '100%' });
    }, 120_000);

    it('hides navigation until hover on web and omits the footer index', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <AttachmentImagePreviewModal
                    onClose={() => {}}
                    images={[
                        { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                        { kind: 'direct', uri: 'blob:second', title: 'second.png' },
                    ]}
                    initialIndex={0}
                />,
            );
        });

        expect(tree!.root.findAllByProps({ testID: 'attachment-image-preview-previous' })).toHaveLength(0);
        expect(tree!.root.findAllByProps({ testID: 'attachment-image-preview-next' })).toHaveLength(0);
        expect(tree!.root.findAllByProps({ testID: 'attachment-image-preview-index' })).toHaveLength(0);

        const hoverSurface = tree!.root.findByProps({ testID: 'attachment-image-preview-surface' });
        act(() => {
            hoverSurface.props.onHoverIn?.();
        });

        expect(tree!.root.findAllByProps({ testID: 'attachment-image-preview-previous' })).toHaveLength(1);
        expect(tree!.root.findAllByProps({ testID: 'attachment-image-preview-next' })).toHaveLength(1);
    }, 120_000);

    it('navigates between direct images after hover', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <AttachmentImagePreviewModal
                    onClose={() => {}}
                    images={[
                        { kind: 'direct', uri: 'blob:first', title: 'first.png' },
                        { kind: 'direct', uri: 'blob:second', title: 'second.png' },
                    ]}
                    initialIndex={0}
                />,
            );
        });

        const hoverSurface = tree!.root.findByProps({ testID: 'attachment-image-preview-surface' });
        act(() => {
            hoverSurface.props.onHoverIn?.();
        });

        const nextButton = tree!.root.findByProps({ testID: 'attachment-image-preview-next' });
        act(() => {
            nextButton.props.onPress();
        });

        expect(tree!.root.findByType('Image').props.source).toEqual({ uri: 'blob:second' });
        expect(tree!.root.findByProps({ testID: 'attachment-image-preview-title' }).props.children).toBe('second.png');
    }, 120_000);

    it('renders session-backed images through the shared session preview hook', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <AttachmentImagePreviewModal
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
                />,
            );
        });

        expect(tree!.root.findByType('Image').props.source).toEqual({
            uri: 'data:image/png;base64,.happier/uploads/messages/m1/file.png',
        });
    }, 120_000);

    it('shows the underlying preview error when session image loading fails', async () => {
        const { AttachmentImagePreviewModal } = await import('./AttachmentImagePreviewModal');
        previewState.value = { status: 'error', uri: null, svgXml: null, error: 'internal disk path leaked' };

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <AttachmentImagePreviewModal
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
                />,
            );
        });

        expect(tree!.root.findByProps({ children: 'internal disk path leaked' })).toBeTruthy();
        expect(() => tree!.root.findByProps({ children: 'common.error' })).toThrow();
    }, 120_000);
});
