import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    SvgXml: (props: any) => React.createElement('SvgXml', props),
}));

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: { ...rn.Platform, OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
        Image: (props: any) => React.createElement('Image', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn(), alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() },
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('react-native-unistyles', () => ({
    __esModule: true,
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } } }),
    StyleSheet: { create: (value: any) => (typeof value === 'function' ? value({ colors: { divider: '#222', surfaceHighest: '#111' } }) : value) },
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: () => ({
        status: 'loaded',
        uri: 'data:image/svg+xml;base64,PHN2Zy8+',
        svgXml: '<svg/>',
        error: null,
    }),
}));

describe('AttachmentsInlineImages (svg previews)', () => {
    it('renders an SvgXml preview for svg attachments on native', async () => {
        const { AttachmentsInlineImages } = await import('./AttachmentsInlineImages');

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AttachmentsInlineImages
                    sessionId="s1"
                    attachments={[
                        {
                            name: 'icon.svg',
                            path: 'icon.svg',
                            mimeType: 'image/svg+xml',
                            sizeBytes: 12,
                            sha256: 'hash',
                        },
                    ]}
                    onOpenPath={() => {}}
                />,
            );
        });

        expect(tree.root.findAllByType('SvgXml' as any).length).toBe(1);
    });
});
