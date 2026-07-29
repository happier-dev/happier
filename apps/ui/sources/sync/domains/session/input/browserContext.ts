import { selectBrowserContextComposerAttachments, type BrowserContextState } from '@/sync/domains/browser/context';

export const BROWSER_CONTEXT_MESSAGE_META_KIND_V1 = 'browser_context.v1' as const;

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

    const contexts = attachments.flatMap((attachment) => {
        const item = args.state.itemsById[attachment.contextId];
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
            happierBrowserContext: {
                kind: BROWSER_CONTEXT_MESSAGE_META_KIND_V1,
                payload: {
                    contexts,
                    attachments,
                },
            },
        },
    };
}

export function mergeBrowserContextMessageMetaOverrides(args: Readonly<{
    state: BrowserContextState | null | undefined;
    metaOverrides?: Record<string, unknown>;
}>): BrowserContextMessageMetaMergeResult {
    if (!args.state || selectBrowserContextComposerAttachments(args.state).length === 0) {
        return {
            ok: true,
            metaOverrides: args.metaOverrides,
        };
    }

    const browserContextMeta = buildBrowserContextMessageMetaOverrides({
        state: args.state,
    });
    if (!browserContextMeta.ok) return browserContextMeta;

    return {
        ok: true,
        metaOverrides: {
            ...(args.metaOverrides ?? {}),
            ...browserContextMeta.metaOverrides,
        },
    };
}

export function hasBrowserContextComposerAttachments(state: BrowserContextState | null | undefined): boolean {
    return Boolean(state && selectBrowserContextComposerAttachments(state).length > 0);
}
