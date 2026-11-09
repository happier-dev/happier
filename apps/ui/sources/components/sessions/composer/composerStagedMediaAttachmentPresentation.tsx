import * as React from 'react';
import { View } from 'react-native';
import type {
    ComposerAttachmentViewV1} from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type {
    ComposerContentHandleV1,
} from '@happier-dev/protocol/runtime/input/composerContentV1';

import { ComposerStagedMediaPreview } from '@/components/sessions/attachments/preview/ComposerStagedMediaPreview';
import { openMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type {
    ComposerAttachmentCatalogRowDescriptor,
    ComposerAttachmentRowMediaPresentation,
} from '@/components/sessions/agentInput/agentInputContracts';

const FILL = { width: '100%', height: '100%' } as const;

function resolveStagedMediaAlphaCapable(handle: ComposerContentHandleV1): boolean {
    return resolveFileViewerKind({ path: handle.name, mimeType: handle.mimeType }).alphaCapable;
}

function createHostPreviewAction(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor;
    handle: ComposerContentHandleV1;
    originRef: React.RefObject<View | null>;
}>): (() => void) | undefined {
    const preview = input.catalog.preview;
    if (preview?.kind !== 'host' || preview.presentation !== input.handle.mediaKind) return undefined;
    // The tile and the stage share one preview identity, so the stage shows the staged bytes it already holds.
    return () => {
        openMediaStage([{
            kind: input.handle.mediaKind === 'video' ? 'video' : 'image',
            title: input.attachment.presentation.label,
            alphaCapable: resolveStagedMediaAlphaCapable(input.handle),
            source: {
                source: { kind: 'composerStage', handle: input.handle },
                enabled: true,
                cacheKey: input.handle.sha256,
                mimeType: input.handle.mimeType,
                sizeBytes: input.handle.sizeBytes,
            },
            sizeBytes: input.handle.sizeBytes,
            originRef: input.originRef,
        }], 0);
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
    const originRef = React.createRef<View>();
    const onPress = createHostPreviewAction({ ...input, originRef });
    return {
        media: input.handle.mediaKind,
        // The tray tile and the stage put the same picture on the same transparency board.
        alphaCapable: resolveStagedMediaAlphaCapable(input.handle),
        renderedPreview: React.createElement(View, { ref: originRef, collapsable: false, style: FILL },
            React.createElement(ComposerStagedMediaPreview, {
                handle: input.handle,
                accessibilityLabel: input.attachment.presentation.label,
                testID: `composer-staged-media:${input.attachment.instanceId}`,
            })),
        ...(onPress === undefined ? {} : { onPress }),
    };
}
