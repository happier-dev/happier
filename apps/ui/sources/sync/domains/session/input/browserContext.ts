import { selectBrowserContextComposerAttachments, type BrowserContextState } from '@/sync/domains/browser/context';
import type { BrowserContextMessagePayloadV1, BrowserContextAnnotationItemV2 } from '@happier-dev/protocol/browser/context/v1';
import { buildBrowserContextAnnotationStructuredBlockV2 } from '@happier-dev/protocol/browser/context/annotationStructuredBlock';
import { mergeMessageMetaOverrides } from '@/sync/domains/messages/mergeMessageMetaOverrides';

export type BrowserAnnotationPicture = Pick<BrowserContextAnnotationItemV2, 'annotationId' | 'marks' | 'imageRef'>;
type BrowserAnnotationUpload = Readonly<{ browserAnnotation?: BrowserAnnotationPicture }>;

/** Send projects source facts onto the picture that owns the current pixels and marks. */
export function reconcileBrowserContextPictures(payload: BrowserContextMessagePayloadV1,
    uploaded: readonly BrowserAnnotationUpload[]): BrowserContextMessagePayloadV1 {
    const pictures = new Map(uploaded.flatMap(image => image.browserAnnotation ? [[image.browserAnnotation.annotationId, image.browserAnnotation] as const] : []));
    if (pictures.size === 0) return payload;
    const contexts = payload.contexts.map(item => {
        const picture = item.kind === 'browserAnnotation' ? pictures.get(item.annotationId) : undefined;
        if (!picture || item.kind !== 'browserAnnotation') return item;
        const markIds = new Set(picture.marks.marks.filter(mark => mark.kind === 'element').map(mark => mark.id));
        return { ...item, marks: picture.marks, imageRef: picture.imageRef, elements: item.elements.filter(element => markIds.has(element.markId)) };
    });
    const byId = new Map(contexts.map(item => [item.contextId, item]));
    return { ...payload, contexts, attachments: payload.attachments.map(attachment => {
        const item = byId.get(attachment.contextId);
        return item?.kind === 'browserAnnotation' ? { ...attachment,
            structuredBlock: buildBrowserContextAnnotationStructuredBlockV2(item) } : attachment;
    }) };
}

export type BrowserContextMessageMetaBuildResult =
    | Readonly<{
        ok: true;
        metaOverrides: Record<string, unknown>;
      }>
    | Readonly<{
        ok: false;
        reasonCode:
            | 'browser_context_no_attachments'
            | 'browser_context_navigation_stale'
            | 'browser_context_attachment_unavailable';
        staleAttachmentIds?: readonly string[];
        unavailableAttachmentIds?: readonly string[];
      }>;

export type BrowserContextMessageMetaMergeResult =
    | Readonly<{
        ok: true;
        metaOverrides?: Record<string, unknown>;
      }>
    | Exclude<BrowserContextMessageMetaBuildResult, { ok: true }>;

export function buildBrowserContextMessageMetaOverrides(args: Readonly<{
    state: BrowserContextState;
    attachmentIds?: readonly string[];
    uploadedAttachments?: readonly BrowserAnnotationUpload[];
}>): BrowserContextMessageMetaBuildResult {
    const allowedAttachmentIds = args.attachmentIds ? new Set(args.attachmentIds) : null;
    const attachments = selectBrowserContextComposerAttachments(args.state)
        .filter((attachment) => !allowedAttachmentIds || allowedAttachmentIds.has(attachment.attachmentId));

    if (attachments.length === 0) {
        return {
            ok: false,
            reasonCode: 'browser_context_no_attachments',
        };
    }

    const staleAttachmentIds = attachments
        .filter((attachment) => attachment.state === 'navigationStale' || attachment.requiresReconfirmBeforeSend)
        .map((attachment) => attachment.attachmentId);
    if (staleAttachmentIds.length > 0) {
        return {
            ok: false,
            reasonCode: 'browser_context_navigation_stale',
            staleAttachmentIds,
        };
    }

    const unavailableAttachmentIds = attachments
        .filter((attachment) => attachment.state !== 'available')
        .map((attachment) => attachment.attachmentId);
    if (unavailableAttachmentIds.length > 0) {
        return {
            ok: false,
            reasonCode: 'browser_context_attachment_unavailable',
            unavailableAttachmentIds,
        };
    }

    const contextIds = new Set(attachments.flatMap((attachment) => [
        attachment.contextId,
        ...(attachment.structuredBlock?.contextIds ?? []),
    ]));
    const contexts = [...contextIds].flatMap((contextId) => {
        const item = args.state.itemsById[contextId];
        return item ? [item] : [];
    });

    if (contexts.length === 0) {
        return {
            ok: false,
            reasonCode: 'browser_context_no_attachments',
        };
    }

    return {
        ok: true,
        metaOverrides: {
            happierStructuredInputV1: {
                v: 1,
                browserContext: reconcileBrowserContextPictures({
                    contexts,
                    attachments,
                }, args.uploadedAttachments ?? []),
            },
        },
    };
}

export function mergeBrowserContextMessageMetaOverrides(args: Readonly<{
    state: BrowserContextState | null | undefined;
    metaOverrides?: Record<string, unknown>;
    uploadedAttachments?: readonly BrowserAnnotationUpload[];
}>): BrowserContextMessageMetaMergeResult {
    if (!args.state || selectBrowserContextComposerAttachments(args.state).length === 0) {
        return {
            ok: true,
            metaOverrides: args.metaOverrides,
        };
    }

    const browserContextMeta = buildBrowserContextMessageMetaOverrides({
        state: args.state,
        uploadedAttachments: args.uploadedAttachments,
    });
    if (!browserContextMeta.ok) return browserContextMeta;

    return {
        ok: true,
        metaOverrides: mergeMessageMetaOverrides(args.metaOverrides, browserContextMeta.metaOverrides),
    };
}

export function hasBrowserContextComposerAttachments(state: BrowserContextState | null | undefined): boolean {
    return Boolean(state && selectBrowserContextComposerAttachments(state).length > 0);
}
