import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { getPreferredLanguage, t } from '@/text';

/**
 * Why a preview has no picture, from the owner's typed code (never its message). Every media surface
 * (image well, image compare, Media stage) reads the same reason and says it the same way.
 */
export type PreviewUnavailable =
    /** Over the preview budget: its size when the listing knows it. */
    | Readonly<{ kind: 'tooLarge'; sizeBytes: number | null }>
    | Readonly<{ kind: 'unsupported' }>
    /** Not there (a missing file, or a revision without it). */
    | Readonly<{ kind: 'missing' }>
    /** The bytes arrived but did not verify. */
    | Readonly<{ kind: 'unverified'; error: string }>
    /** The read or its transfer did not finish: the only reason reading again can help. */
    | Readonly<{ kind: 'loadFailed'; error: string }>;

export function resolvePreviewUnavailable(input: Readonly<{
    error: string;
    errorCode?: string | null;
    sizeBytes?: number | null;
}>): PreviewUnavailable {
    switch (input.errorCode) {
        case 'too_large': return { kind: 'tooLarge', sizeBytes: input.sizeBytes ?? null };
        case 'unsupported': return { kind: 'unsupported' };
        case 'not_found': return { kind: 'missing' };
        case 'blob_unavailable': return { kind: 'unverified', error: input.error };
        default: return { kind: 'loadFailed', error: input.error };
    }
}

export type PreviewUnavailableCard = Readonly<{
    kind: 'empty' | 'error';
    title: string;
    reason?: string;
    diagnosticCode?: string;
    /** The picture glyph for a pane-size card when nothing failed (lab FV4e); a line card stays bare. */
    iconName?: 'image';
    /** Only a read that did not finish offers Retry. */
    retryable: boolean;
}>;

/** The state card's copy. Only a failed read or unverified bytes are failures; the rest are facts about the file. */
export function previewUnavailableCard(reason: PreviewUnavailable, name: string): PreviewUnavailableCard {
    switch (reason.kind) {
        case 'tooLarge': return { kind: 'empty', iconName: 'image', title: t('hunkReview.imageTooLarge'), retryable: false,
            ...(reason.sizeBytes !== null ? { reason: formatHappierDataBytes(reason.sizeBytes, { kind: 'storage', locale: getPreferredLanguage() }) } : {}) };
        case 'unsupported': return { kind: 'empty', iconName: 'image', title: t('hunkReview.imageUnsupported'), retryable: false };
        case 'missing': return { kind: 'empty', iconName: 'image', title: t('hunkReview.imageMissing'), retryable: false };
        case 'unverified': return { kind: 'error', title: t('hunkReview.imageUnreadable'), retryable: false };
        case 'loadFailed': return { kind: 'error', title: t('files.viewer.loadFailed', { name }), diagnosticCode: reason.error, retryable: true };
    }
}
