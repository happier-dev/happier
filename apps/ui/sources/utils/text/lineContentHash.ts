import {
    computeLineContentHashV1,
    isLineContentHashV1,
    normalizeLineContentForHashV1,
    type LineContentHashV1,
} from '@happier-dev/protocol/workspace/anchors/v1';

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
