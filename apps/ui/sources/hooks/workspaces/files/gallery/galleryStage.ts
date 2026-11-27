import type { MediaStageOpener } from '@/components/ui/media/stage/useMediaStage';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import type { GalleryMediaItem } from './galleryModel';

export function createGalleryPreviewInput(
    item: GalleryMediaItem,
    enabled: boolean,
    options?: Pick<UseFilePreviewSourceInput, 'maxBytes' | 'cacheOnly'>,
): UseFilePreviewSourceInput {
    return {
        enabled,
        source: { kind: 'workspace', scope: item.scope, filePath: item.path },
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        ...(enabled && item.modifiedMs != null
            ? buildWorkspacePreviewIdentity(item.scope, item.path, item.sizeBytes, String(item.modifiedMs)) : {}),
        ...options,
    };
}

type StageActions = (item: GalleryMediaItem) => Partial<Pick<MediaStageItem, 'subtitle' | 'originRef' | 'openFile' | 'targetSession'>>;
export function createGalleryStageItems(items: readonly GalleryMediaItem[], actions?: StageActions): readonly MediaStageItem[] {
    return items.map(item => ({
        kind: item.kind, title: item.name, source: createGalleryPreviewInput(item, true),
        alphaCapable: item.alphaCapable, sizeBytes: item.sizeBytes, ...actions?.(item),
    }));
}

/** Pass the current gallery in visual order. The stage owner freezes it when opened. */
export function openGalleryStage(opener: MediaStageOpener, items: readonly GalleryMediaItem[], itemId: string, actions?: StageActions): string | null {
    const index = items.findIndex(item => item.id === itemId);
    return index === -1 ? null : opener.open(createGalleryStageItems(items, actions), index);
}
