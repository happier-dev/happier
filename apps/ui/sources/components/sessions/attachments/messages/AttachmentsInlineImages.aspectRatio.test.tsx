import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { installSessionAttachmentCommonModuleMocks } from '../sessionAttachmentTestHelpers';

installSessionAttachmentCommonModuleMocks({
    reactNative: installReactNativeWebMock(),
    unistyles: installUnistylesMock({
        theme: { colors: { textSecondary: '#bbb', divider: '#222', surfaceHighest: '#111' } },
    }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: () => ({
        status: 'loaded',
        uri: 'blob:preview',
        svgXml: null,
        error: null,
    }),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('AttachmentsInlineImages aspect ratios', () => {
    it('preserves transcript attachment image aspect ratios after loaded previews report dimensions', async () => {
        const { AttachmentsInlineImages } = await import('./AttachmentsInlineImages');

        const attachment = {
            name: 'wide.png',
            path: '.happier/uploads/messages/message-1/wide.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            sha256: 'hash',
        };

        const screen = await renderScreen(
            <AttachmentsInlineImages
                sessionId="s1"
                attachments={[attachment]}
                onOpenPath={() => {}}
            />,
        );

        const tileTestID = `message-attachments-inline-image:${attachment.path}`;
        const previewTestID = `message-attachments-inline-image-preview:${attachment.path}`;

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 84,
            height: 84,
        });

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId(previewTestID), 'onLoad', {
                nativeEvent: {
                    source: { width: 1600, height: 900 },
                },
            });
        });

        expect(flattenStyle(screen.findByTestId(tileTestID)?.props.style)).toMatchObject({
            width: 220,
            height: 124,
        });
        expect(screen.findByTestId(previewTestID)?.props.resizeMode).toBe('contain');
    });
});
