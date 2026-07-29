import { BrowserContextAttachmentV1Schema, type BrowserContextAttachmentV1 } from '@happier-dev/protocol';

import type { BrowserContextState } from './types';

/**
 * ANNO-2/ANNO-4 grouping: a multi-target annotation is N `browserAnnotation` items sharing one
 * `annotationId`. The composer + agent turn render exactly ONE card per group, so this selector
 * collapses the items by `annotationId` (preserving capture order) into a single group descriptor
 * carrying the shared media + comment + the list of member contextIds. Clearing/deleting a card maps
 * back to all member ids so the group is removed atomically (and its shared media released once).
 */
export type BrowserAnnotationGroup = Readonly<{
    annotationId: string;
    sourceViewId: string;
    mediaId: string;
    comment?: string;
    contextIds: readonly string[];
    targetCount: number;
    capturedAtMs: number;
}>;

export function selectBrowserAnnotationGroups(
    state: BrowserContextState,
): readonly BrowserAnnotationGroup[] {
    const byAnnotationId = new Map<string, {
        annotationId: string;
        sourceViewId: string;
        mediaId: string;
        comment?: string;
        contextIds: string[];
        capturedAtMs: number;
    }>();
    const order: string[] = [];
    for (const contextId of state.itemOrder) {
        const item = state.itemsById[contextId];
        if (!item || item.kind !== 'browserAnnotation') continue;
        const existing = byAnnotationId.get(item.annotationId);
        if (existing) {
            existing.contextIds.push(item.contextId);
            if (!existing.comment && item.comment) existing.comment = item.comment;
            continue;
        }
        order.push(item.annotationId);
        byAnnotationId.set(item.annotationId, {
            annotationId: item.annotationId,
            sourceViewId: item.sourceViewId,
            mediaId: item.media.mediaId,
            ...(item.comment ? { comment: item.comment } : {}),
            contextIds: [item.contextId],
            capturedAtMs: item.capturedAtMs,
        });
    }
    return order.map((annotationId) => {
        const group = byAnnotationId.get(annotationId)!;
        return {
            annotationId: group.annotationId,
            sourceViewId: group.sourceViewId,
            mediaId: group.mediaId,
            ...(group.comment ? { comment: group.comment } : {}),
            contextIds: group.contextIds,
            targetCount: group.contextIds.length,
            capturedAtMs: group.capturedAtMs,
        };
    });
}

export function selectBrowserContextComposerAttachments(
    state: BrowserContextState,
): readonly BrowserContextAttachmentV1[] {
    return state.attachmentOrder.flatMap((attachmentId) => {
        const record = state.attachmentsById[attachmentId];
        if (!record) return [];
        const item = state.itemsById[record.contextId];
        if (!item) return [];

        const currentNavigationGeneration = state.navigationGenerationByViewId[item.sourceViewId] ?? item.navigationGeneration;
        const stale = currentNavigationGeneration !== item.navigationGeneration;

        return [BrowserContextAttachmentV1Schema.parse({
            v: 1,
            attachmentId: record.attachmentId,
            contextId: record.contextId,
            sourceViewId: item.sourceViewId,
            capturedNavigationGeneration: item.navigationGeneration,
            currentNavigationGeneration,
            state: stale ? 'navigationStale' : item.lifecycleState,
            requiresReconfirmBeforeSend: stale,
        })];
    });
}
