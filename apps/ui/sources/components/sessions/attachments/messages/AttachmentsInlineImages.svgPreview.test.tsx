import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { installSessionAttachmentCommonModuleMocks } from '../sessionAttachmentTestHelpers';

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (values: { ios?: unknown; default?: unknown } | undefined) => values?.ios ?? values?.default ?? null,
        },
    }),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
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
