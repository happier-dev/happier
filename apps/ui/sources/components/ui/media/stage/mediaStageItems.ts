import type * as React from 'react';
import type { View } from 'react-native';
import type { UseFilePreviewSourceInput } from '../useFilePreviewSource';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import type { ImageAnnotationSource } from '../annotation/annotatorStore';
import type { CommitComposerPictureResult } from '@/components/sessions/composer/replaceComposerPicture';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type StagePictureCommitResult = CommitComposerPictureResult | Readonly<{ ok: false; reason: string }>;

export type StagePictureEdit = Readonly<{
    document?: ImageMarksDocumentV1;
    /** Resolves the original only when Annotate is entered, never while viewing/paging. */
    original?: () => Promise<ImageAnnotationSource | null>;
    commit: (result: Readonly<{ source: ImageAnnotationSource; document: ImageMarksDocumentV1 }>) => Promise<StagePictureCommitResult>;
    revert: () => Promise<StagePictureCommitResult>;
}>;

export type MediaStageItem = Readonly<{
    kind: 'image' | 'svg' | 'video' | 'pdf';
    title: string;
    /** Caller-owned context, kept visible alongside the media's original name. */
    subtitle?: string;
    source: UseFilePreviewSourceInput;
    sizeBytes?: number | null;
    /** From the classifier (`alphaCapable`): the picture sits on its well's checkerboard or Background. */
    alphaCapable?: boolean;
    originRef?: React.RefObject<View | null>;
    openFile?: () => void;
    edit?: StagePictureEdit;
    /** Tray Edit marks opens directly in the same stage mode. */
    annotate?: boolean;
    /** Chooser's default only; its canonical resolver still decides the destination. */
    targetSession?: SessionAddress;
    /** A paused video frame held for marking: its time travels with the copy's words. */
    frameTime?: string;
}>;

export type MediaStageProps = Readonly<{
    items: readonly MediaStageItem[];
    initialIndex: number;
}>;

/** A stage reads the gallery as it was when opened, even while its transcript grows. */
export function freezeMediaStageGallery(items: readonly MediaStageItem[], index = 0): MediaStageProps {
    if (items.length === 0) throw new RangeError('A media stage requires an item');
    const initialIndex = Number.isFinite(index) ? Math.max(0, Math.min(items.length - 1, Math.trunc(index))) : 0;
    return { items: Object.freeze(items.map(item => Object.freeze({ ...item }))), initialIndex };
}
