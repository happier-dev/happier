import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'ios',
                    select: (values: { ios?: unknown; default?: unknown } | undefined) => values?.ios ?? values?.default ?? null,
                },
            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: vi.fn(),
            alert: vi.fn(),
            confirm: vi.fn(),
            prompt: vi.fn(),
        },
    }).module;
});

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    });
});

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

        const screen = await renderScreen(
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

        expect(screen.tree.findAllByType('SvgXml').length).toBe(1);
    });
});
