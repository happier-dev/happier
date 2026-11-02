import { BrowserContextAttachmentV1Schema, type BrowserContextAttachmentV1 } from '@happier-dev/protocol/browser/context/v1';
import { buildBrowserContextAnnotationStructuredBlockV2 } from '@happier-dev/protocol/browser/context/annotationStructuredBlock';

import type { BrowserContextState } from './types';


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
        const structuredBlock = item.kind === 'browserAnnotation'
            ? buildBrowserContextAnnotationStructuredBlockV2(item)
            : undefined;

        return [BrowserContextAttachmentV1Schema.parse({
            v: 1,
            attachmentId: record.attachmentId,
            contextId: record.contextId,
            sourceViewId: item.sourceViewId,
            capturedNavigationGeneration: item.navigationGeneration,
            currentNavigationGeneration,
            state: stale ? 'navigationStale' : item.lifecycleState,
            requiresReconfirmBeforeSend: stale,
            ...(structuredBlock ? { structuredBlock } : {}),
        })];
    });
}
