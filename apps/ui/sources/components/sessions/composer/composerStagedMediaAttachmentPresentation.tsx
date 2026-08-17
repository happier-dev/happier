import * as React from 'react';
import type {
    ComposerAttachmentViewV1,
    ComposerContentHandleV1,
} from '@happier-dev/protocol';

import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import { ComposerStagedMediaPreview } from '@/components/sessions/attachments/preview/ComposerStagedMediaPreview';
import { ComposerStagedMediaPreviewModal } from '@/components/sessions/attachments/preview/ComposerStagedMediaPreviewModal';
import type {
    ComposerAttachmentCatalogRowDescriptor,
    ComposerAttachmentRowMediaPresentation,
} from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';

function createHostPreviewAction(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor;
    handle: ComposerContentHandleV1;
}>): (() => void) | undefined {
    const preview = input.catalog.preview;
    if (preview?.kind !== 'host' || preview.presentation !== input.handle.mediaKind) return undefined;

    if (input.handle.mediaKind === 'image') {
        return () => {
            const image: AttachmentImagePreviewModalImage = {
                kind: 'composer-staged-image',
                title: input.attachment.presentation.label,
                handle: input.handle,
            };
            Modal.show({
                component: AttachmentImagePreviewModal,
                props: { images: [image] },
            });
        };
    }

    return () => {
        Modal.show({
            component: ComposerStagedMediaPreviewModal,
            props: {
                handle: input.handle,
                title: input.attachment.presentation.label,
            },
        });
    };
}

/**
 * One host presentation adapter for approved staged Composer media. It is
 * called only after the attachment projection has established exact catalog
 * identity, handle ownership, and media-kind equality.
 */
export function createComposerStagedMediaAttachmentPresentation(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor;
    handle: ComposerContentHandleV1;
}>): ComposerAttachmentRowMediaPresentation {
    const onPress = createHostPreviewAction(input);
    return {
        media: input.handle.mediaKind,
        renderedPreview: React.createElement(ComposerStagedMediaPreview, {
            handle: input.handle,
            accessibilityLabel: input.attachment.presentation.label,
            testID: `composer-staged-media:${input.attachment.instanceId}`,
        }),
        ...(onPress === undefined ? {} : { onPress }),
    };
}
