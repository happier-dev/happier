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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/sessions/attachments/preview/AttachmentImagePreviewModal', () => ({
    AttachmentImagePreviewModal: () => null,
}));

vi.mock('@/components/sessions/files/content/imagePreview/useSessionImagePreview', () => ({
    useSessionImagePreview: vi.fn(),
}));

describe('AttachmentsInlineImages (svg previews)', () => {
    it('does not render svg attachments as inline transcript images in the V1 media policy', async () => {
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
                fileOpenEnabled
                mediaPreviewEnabled
            />,
        );

        expect(screen.findByTestId('message-attachments-inline-images')).toBeNull();
    });
});
