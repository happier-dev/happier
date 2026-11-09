import * as React from 'react';
import type { ScmComparisonFile, ScmDiffArea } from '@happier-dev/protocol/scm';

import { useFileAtRevisionPreview } from '@/components/ui/media/useFileAtRevisionPreview';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import { createImagePreviewAcquisition } from '@/components/ui/media/imagePreviewCache';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { buildImageCompareModel, projectImageComparePreview } from './imageCompareModel';

export type ImageCompareSource =
    | Readonly<{ kind: 'captured'; file: ScmComparisonFile; comparisonId: string }>
    | Readonly<{ kind: 'workingTree'; changeKind: string; area: ScmDiffArea; signature?: string | null; sizeBytes?: number | null }>;

/** A changed picture or PDF opens in the Media stage as itself. */
function stageItemKind(kind: ReturnType<typeof resolveFileViewerKind>['kind']): MediaStageItem['kind'] {
    return kind === 'svg' || kind === 'pdf' ? kind : 'image';
}

/** Review and File Changes share pinned revision bytes and the normal live-after preview owner (pictures and PDFs). */
export function useImageCompare(input: Readonly<{
    enabled: boolean;
    scope: WorkspaceScopeBase;
    filePath: string;
    source: ImageCompareSource;
    beforeTitle?: string;
    afterTitle?: string;
    openFile?: () => void;
}>) {
    const captured = input.source.kind === 'captured' ? input.source : null;
    const live = input.source.kind === 'workingTree' ? input.source : null;
    const changeKind = captured?.file.changeKind ?? live!.changeKind;
    const beforeAbsent = changeKind === 'added' || changeKind === 'untracked';
    const afterAbsent = changeKind === 'deleted';
    const viewer = resolveFileViewerKind({ path: input.filePath });
    const beforeViewer = resolveFileViewerKind({ path: captured?.file.previousPath ?? input.filePath });
    // A side whose read did not finish is read again on Retry; the other side keeps its bytes.
    const [attempts, retry] = React.useReducer((current: Readonly<{ before: number; after: number }>, side: 'before' | 'after') =>
        ({ ...current, [side]: current[side] + 1 }), { before: 0, after: 0 });
    const beforeBlobId = captured?.file.beforeBlobId;
    const afterBlobId = captured?.file.afterBlobId;
    const before = useFileAtRevisionPreview({
        enabled: input.enabled && !beforeAbsent && (!captured || Boolean(beforeBlobId)),
        scope: input.scope, path: captured?.file.previousPath ?? input.filePath,
        selector: beforeBlobId ? { blobId: beforeBlobId } : { side: 'before', area: live?.area ?? 'both' },
        mimeType: beforeViewer.mimeType, signature: captured?.comparisonId ?? live?.signature, attempt: attempts.before,
    });
    const capturedAfter = useFileAtRevisionPreview({
        enabled: input.enabled && !afterAbsent && Boolean(captured && afterBlobId),
        scope: input.scope, path: input.filePath,
        selector: afterBlobId ? { blobId: afterBlobId } : { side: 'before', area: 'both' },
        mimeType: viewer.mimeType, signature: captured?.comparisonId, attempt: attempts.after,
    });
    const { serverId, machineId, rootPath } = input.scope;
    const liveAfterInput = React.useMemo<UseFilePreviewSourceInput>(() => {
        const enabled = input.enabled && !afterAbsent && Boolean(live);
        const identity = enabled ? buildWorkspacePreviewIdentity(input.scope, input.filePath, live?.sizeBytes, live?.signature) : null;
        return {
            enabled,
            source: { kind: 'workspace', scope: { serverId, machineId, rootPath }, filePath: input.filePath },
            mimeType: viewer.mimeType, sizeBytes: live?.sizeBytes, ...identity,
            // This mounted comparison owns one live read; wells, modes and stage borrow that read.
            ...(enabled && !identity?.cacheKey ? { acquisitionKey: createImagePreviewAcquisition() } : {}),
            // The preview owner retries keyed and unkeyed reads without inventing a version for either.
            retryCount: attempts.after,
        };
    }, [input.enabled, afterAbsent, Boolean(live), serverId, machineId, rootPath, input.filePath, viewer.mimeType,
        live?.sizeBytes, live?.signature, attempts.after]);
    const liveAfter = useFilePreviewSource(liveAfterInput);
    const beforePreview = captured && !beforeAbsent && !beforeBlobId
        ? { status: 'error' as const, error: 'blob_unavailable', errorCode: 'blob_unavailable' }
        : projectImageComparePreview(before);
    const afterPreview = captured && !afterAbsent && !afterBlobId
        ? { status: 'error' as const, error: 'blob_unavailable', errorCode: 'blob_unavailable' }
        // An over-budget live after says its size; the working-tree listing knows it.
        : projectImageComparePreview(captured ? capturedAfter
            : liveAfter.status === 'error' ? { ...liveAfter, sizeBytes: live?.sizeBytes ?? null } : liveAfter);
    const beforeItem: MediaStageItem = { kind: stageItemKind(beforeViewer.kind), title: input.beforeTitle ?? input.filePath, source: before.previewInput, alphaCapable: beforeViewer.alphaCapable,
        ...('sizeBytes' in before ? { sizeBytes: before.sizeBytes } : {}), ...(input.openFile ? { openFile: input.openFile } : {}) };
    const afterInput = captured ? capturedAfter.previewInput : liveAfterInput;
    const afterItem: MediaStageItem = { kind: stageItemKind(viewer.kind), title: input.afterTitle ?? input.filePath, source: afterInput, alphaCapable: viewer.alphaCapable,
        ...(afterPreview.status === 'loaded' ? { sizeBytes: afterPreview.sizeBytes } : {}), ...(input.openFile ? { openFile: input.openFile } : {}) };
    const model = buildImageCompareModel({ changeKind, before: beforePreview, after: afterPreview, beforeItem, afterItem });
    return { ...model, retry, beforePreviewInput: before.previewInput, afterPreviewInput: afterInput,
        beforeGalleryIndex: model.before.kind === 'present' ? 0 : null,
        afterGalleryIndex: model.after.kind === 'present' ? model.before.kind === 'present' ? 1 : 0 : null };
}
