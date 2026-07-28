import type { MessageMeta } from './messageMetaTypes';

export type UnsupportedContentKind =
    | 'unparsed-user-message'
    | 'unparsed-agent-message'
    | 'unsupported-agent-output'
    | 'unsupported-transcript-record';

const UNSUPPORTED_CONTENT_KINDS = new Set<UnsupportedContentKind>([
    'unparsed-user-message',
    'unparsed-agent-message',
    'unsupported-agent-output',
    'unsupported-transcript-record',
]);

const UNSUPPORTED_CONTENT_META_KEY = 'happierUnsupportedContentV1';

export function markUnsupportedContentMeta(meta: MessageMeta | undefined, kind: UnsupportedContentKind): MessageMeta {
    return {
        ...(meta ?? {}),
        [UNSUPPORTED_CONTENT_META_KEY]: kind,
    } as MessageMeta;
}

export function readUnsupportedContentMeta(meta: unknown): UnsupportedContentKind | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const kind = (meta as Record<string, unknown>)[UNSUPPORTED_CONTENT_META_KEY];
    return typeof kind === 'string' && UNSUPPORTED_CONTENT_KINDS.has(kind as UnsupportedContentKind)
        ? kind as UnsupportedContentKind
        : null;
}
