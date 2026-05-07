const LINE_CONTENT_HASH_PREFIX = 'lh1:';
const LINE_CONTENT_HASH_PATTERN = /^lh1:[0-9a-f]{16}$/;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export type LineContentHash = `lh1:${string}`;

function toHex32(value: number): string {
    return (value >>> 0).toString(16).padStart(8, '0');
}

export function normalizeLineContentForHash(line: string): string {
    return String(line ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function computeLineContentHash(line: string): LineContentHash {
    const normalized = normalizeLineContentForHash(line);
    let first = FNV_OFFSET_BASIS;
    let second = FNV_OFFSET_BASIS ^ normalized.length;

    for (let index = 0; index < normalized.length; index += 1) {
        const code = normalized.charCodeAt(index);
        first = Math.imul(first ^ code, FNV_PRIME);
        second = Math.imul(second ^ ((code << 5) | (code >>> 11)), FNV_PRIME);
    }

    return `${LINE_CONTENT_HASH_PREFIX}${toHex32(first)}${toHex32(second)}`;
}

export function isLineContentHash(value: unknown): value is LineContentHash {
    return typeof value === 'string' && LINE_CONTENT_HASH_PATTERN.test(value);
}

export function findLineIndexByContentHash<TLine>(params: Readonly<{
    lines: readonly TLine[];
    lineHash: LineContentHash | null | undefined;
    getLineContent: (line: TLine, index: number) => string | null | undefined;
    isCandidate?: (line: TLine, index: number) => boolean;
}>): number {
    if (!params.lineHash) return -1;

    for (let index = 0; index < params.lines.length; index += 1) {
        const line = params.lines[index];
        if (line === undefined) continue;
        if (params.isCandidate && !params.isCandidate(line, index)) continue;
        const content = params.getLineContent(line, index);
        if (typeof content !== 'string') continue;
        if (computeLineContentHash(content) === params.lineHash) {
            return index;
        }
    }

    return -1;
}
