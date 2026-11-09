export function objectKeyCount(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return Object.keys(value as Record<string, unknown>).length;
}

/** Preserve the former default-container bucket cut points as literal pixels. */
export function serializePaneSizePxBucket(
    smallMaxPx: number,
    mediumMaxPx: number,
) {
    return (value: number): 'small' | 'medium' | 'large' => {
        if (value <= smallMaxPx) return 'small';
        if (value <= mediumMaxPx) return 'medium';
        return 'large';
    };
}

