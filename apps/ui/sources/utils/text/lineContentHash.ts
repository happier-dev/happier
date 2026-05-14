import {
    computeLineContentHashV1,
    isLineContentHashV1,
    normalizeLineContentForHashV1,
    type LineContentHashV1,
} from '@happier-dev/protocol';

export type LineContentHash = LineContentHashV1;

export function normalizeLineContentForHash(line: string): string {
    return normalizeLineContentForHashV1(line);
}

export function computeLineContentHash(line: string): LineContentHash {
    return computeLineContentHashV1(line);
}

export function isLineContentHash(value: unknown): value is LineContentHash {
    return isLineContentHashV1(value);
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
