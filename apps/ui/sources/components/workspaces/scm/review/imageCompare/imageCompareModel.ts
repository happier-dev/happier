import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { resolvePreviewUnavailable, type PreviewUnavailable } from '@/components/ui/media/previewUnavailable';

export type ImageComparePreview =
    | Readonly<{ status: 'loaded'; uri: string; sizeBytes?: number | null }>
    | Readonly<{ status: 'empty' }>
    | Readonly<{ status: 'disabled' | 'loading' }>
    | Readonly<{ status: 'error'; error: string; errorCode?: string; sizeBytes?: number | null }>;

export function projectImageComparePreview(preview: Readonly<{
    status: 'loaded' | 'loading' | 'disabled' | 'error';
    uri: string | null;
    error: string | null;
    errorCode?: string | null;
    sizeBytes?: number | null;
    byteLength?: number;
}>): ImageComparePreview {
    if (preview.status === 'error') return { status: 'error', error: preview.error ?? 'blob_unavailable',
        ...(preview.errorCode ? { errorCode: preview.errorCode } : {}),
        ...(typeof preview.sizeBytes === 'number' ? { sizeBytes: preview.sizeBytes } : {}) };
    if (preview.status !== 'loaded') return { status: preview.status };
    if (preview.sizeBytes === 0 || preview.byteLength === 0) return { status: 'empty' };
    if (preview.uri !== null) return { status: 'loaded', uri: preview.uri,
        sizeBytes: preview.sizeBytes ?? preview.byteLength ?? null };
    return { status: 'loading' };
}

export type ImageCompareSide =
    | Readonly<{ kind: 'present'; uri: string; sizeBytes: number | null }>
    | Readonly<{ kind: 'added' | 'deleted' }>
    /** The read gave no picture, and why (too large, unsupported, missing, unverified, or a read that did not finish). */
    | Readonly<{ kind: 'unavailable'; reason: PreviewUnavailable }>
    | Readonly<{ kind: 'noPreview'; reason: 'disabled' | 'loading' | 'empty' }>;

export type ImageCompareModel<StageItem> = Readonly<{
    before: ImageCompareSide;
    after: ImageCompareSide;
    gallery: readonly StageItem[];
}>;

function previewSide(preview: ImageComparePreview): ImageCompareSide {
    if (preview.status === 'empty') return { kind: 'noPreview', reason: 'empty' };
    if (preview.status === 'error') return { kind: 'unavailable', reason: resolvePreviewUnavailable(preview) };
    if (preview.status !== 'loaded') return { kind: 'noPreview', reason: preview.status };
    if (preview.sizeBytes === 0 || !preview.uri) return { kind: 'noPreview', reason: 'empty' };
    return { kind: 'present', uri: preview.uri, sizeBytes: preview.sizeBytes ?? null };
}

/** Projects preview results only; comparison evidence is the sole absence authority. */
export function buildImageCompareModel<StageItem = never>(input: Readonly<{
    changeKind: string;
    before: ImageComparePreview;
    after: ImageComparePreview;
    /** Canonical Media stage items, retaining their preview source/cache lifetime. */
    beforeItem?: StageItem;
    afterItem?: StageItem;
}>): ImageCompareModel<StageItem> {
    const before = input.changeKind === 'added' || input.changeKind === 'untracked' ? { kind: 'added' as const } : previewSide(input.before);
    const after = input.changeKind === 'deleted' ? { kind: 'deleted' as const } : previewSide(input.after);
    const gallery: StageItem[] = [];
    if (before.kind === 'present' && input.beforeItem !== undefined) gallery.push(input.beforeItem);
    if (after.kind === 'present' && input.afterItem !== undefined) gallery.push(input.afterItem);
    return { before, after, gallery };
}

/** A file's size change: storage units, signed by the change's direction; absent unless both sides were read. */
export function formatBytesDelta(
  before: number | null,
  after: number | null,
): string | null {
  if (before === null || after === null) return null;
  const delta = after - before;
  // A file's size is storage: the shared decimal reading, signed by the change's direction.
  return `${delta < 0 ? '−' : '+'}${formatHappierDataBytes(Math.abs(delta), { kind: 'storage' })}`;
}
