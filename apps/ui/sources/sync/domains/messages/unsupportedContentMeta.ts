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

export type UnsupportedContentMetaValue = Readonly<{
    kind: UnsupportedContentKind;
    recordType?: string;
}>;

const UNSUPPORTED_CONTENT_META_KEY = 'happierUnsupportedContentV1';

export function markUnsupportedContentMeta(
    meta: MessageMeta | undefined,
    value: UnsupportedContentMetaValue,
): MessageMeta {
    return {
        ...(meta ?? {}),
        [UNSUPPORTED_CONTENT_META_KEY]: {
            kind: value.kind,
            ...(value.recordType ? { recordType: value.recordType } : {}),
        },
    } as MessageMeta;
}

export function readUnsupportedContentMeta(meta: unknown): UnsupportedContentMetaValue | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const raw = (meta as Record<string, unknown>)[UNSUPPORTED_CONTENT_META_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const kind = (raw as Record<string, unknown>).kind;
    if (typeof kind !== 'string' || !UNSUPPORTED_CONTENT_KINDS.has(kind as UnsupportedContentKind)) return null;
    const recordType = (raw as Record<string, unknown>).recordType;
    return {
        kind: kind as UnsupportedContentKind,
        ...(typeof recordType === 'string' && recordType.length > 0 ? { recordType } : {}),
    };
}
