import type { Metadata } from '@/sync/domains/state/storageTypes';

export type SessionInitialPromptV1 = Readonly<{
    v: 1;
    text: string;
    mode: 'replace' | 'append';
    createdAtMs: number;
    sourceMessageIds?: ReadonlyArray<string>;
    sourceSessionId?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeSourceMessageIds(value: unknown): ReadonlyArray<string> | null {
    if (!Array.isArray(value)) return null;
    const ids = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0);
    return ids.length > 0 ? ids : null;
}

export function readSessionInitialPromptV1(metadata: Metadata | null | undefined): SessionInitialPromptV1 | null {
    const candidate = (metadata as Record<string, unknown> | null | undefined)?.sessionInitialPromptV1;
    if (!isRecord(candidate)) return null;
    if (candidate.v !== 1) return null;
    const text = typeof candidate.text === 'string' ? candidate.text : '';
    if (!text.trim()) return null;
    const mode = candidate.mode === 'replace' || candidate.mode === 'append' ? candidate.mode : null;
    if (!mode) return null;
    const createdAtMs = typeof candidate.createdAtMs === 'number' && Number.isFinite(candidate.createdAtMs)
        ? candidate.createdAtMs
        : 0;
    const sourceMessageIds = sanitizeSourceMessageIds(candidate.sourceMessageIds);
    const sourceSessionId = typeof candidate.sourceSessionId === 'string' && candidate.sourceSessionId.trim().length > 0
        ? candidate.sourceSessionId.trim()
        : null;

    return {
        v: 1,
        text,
        mode,
        createdAtMs,
        ...(sourceMessageIds ? { sourceMessageIds } : null),
        ...(sourceSessionId ? { sourceSessionId } : null),
    };
}

export function writeSessionInitialPromptV1(params: Readonly<{
    metadata: Metadata;
    text: string;
    mode: 'replace' | 'append';
    createdAtMs: number;
    sourceMessageIds?: ReadonlyArray<string> | null;
    sourceSessionId?: string | null;
}>): Metadata {
    const text = typeof params.text === 'string' ? params.text : String(params.text ?? '');
    if (!text.trim()) return params.metadata;
    const sourceMessageIds = sanitizeSourceMessageIds(params.sourceMessageIds);
    const sourceSessionId = typeof params.sourceSessionId === 'string' && params.sourceSessionId.trim().length > 0
        ? params.sourceSessionId.trim()
        : null;

    return {
        ...params.metadata,
        sessionInitialPromptV1: {
            v: 1,
            text,
            mode: params.mode,
            createdAtMs: params.createdAtMs,
            ...(sourceMessageIds ? { sourceMessageIds } : null),
            ...(sourceSessionId ? { sourceSessionId } : null),
        },
    } as Metadata;
}

export function clearSessionInitialPromptV1(params: Readonly<{
    metadata: Metadata;
}>): Metadata {
    const current = readSessionInitialPromptV1(params.metadata);
    if (!current) return params.metadata;
    const next: Record<string, unknown> = { ...params.metadata };
    delete next.sessionInitialPromptV1;
    return next as Metadata;
}
