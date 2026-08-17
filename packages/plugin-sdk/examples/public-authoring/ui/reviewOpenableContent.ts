import type {
    OpenableContentBody,
    OpenableContentReadResult,
    OpenableContentRef,
    OpenableContentStatResult,
    PluginUiHostApi,
} from '@happier-dev/plugin-sdk/ui';

/** The review viewer remains comfortably below the host's immutable hard cap. */
export const REVIEW_OPENABLE_CONTENT_MAX_BYTES = 64 * 1024;

/** Only this declared destination may consume an opaque openable-content reference. */
export const REVIEW_OPENABLE_CONTENT_VIEW_ID = 'review-openable-content';

export type ReviewOpenableContentResult = Exclude<OpenableContentStatResult, Readonly<{
    status: 'ready';
}>> | Exclude<OpenableContentReadResult, Readonly<{
    status: 'ready';
}>> | Readonly<{
    status: 'ready';
    mimeType: string;
    contentClass: string;
    extension?: string;
    sizeBytes: number;
    revision: string;
    content: OpenableContentBody;
}>;

/**
 * A selected viewer receives a host-issued opaque reference as its launch
 * input. This only recognizes that public shape; the host validates it before
 * every stat/read and remains the content, revision, byte-limit, and
 * currentness owner.
 */
export function readReviewOpenableContentReference(value: unknown): OpenableContentRef | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind !== 'workspaceFile' || typeof candidate.handle !== 'string') return undefined;
    return { kind: 'workspaceFile', handle: candidate.handle };
}

/**
 * Read one exact bounded snapshot via the public UI host API. The host owns
 * revision/currentness checks, so this helper never retries, caches, or reads
 * a filesystem path.
 */
export async function readReviewOpenableContent(
    host: PluginUiHostApi,
    ref: OpenableContentRef,
    signal?: AbortSignal,
): Promise<ReviewOpenableContentResult> {
    const options = signal === undefined ? undefined : { signal };
    const stat = await host.statOpenableContent(ref, options);
    if (stat.status !== 'ready') return stat;

    const read = await host.readOpenableContent({
        ref,
        expectedRevision: stat.revision,
        maxBytes: REVIEW_OPENABLE_CONTENT_MAX_BYTES,
    }, options);
    if (read.status !== 'ready') return read;

    return {
        status: 'ready',
        mimeType: stat.mimeType,
        contentClass: stat.contentClass,
        ...(stat.extension === undefined ? {} : { extension: stat.extension }),
        sizeBytes: stat.sizeBytes,
        revision: read.revision,
        content: read.content,
    };
}
