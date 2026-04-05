import { z } from 'zod';

export function bucketNormalizedPaneSize(
    value: number,
    basisValue: unknown,
    smallMaxFraction: number,
    mediumMaxFraction: number,
): 'small' | 'medium' | 'large' {
    const basisPx =
        typeof basisValue === 'number' && Number.isFinite(basisValue) && basisValue > 0
            ? basisValue
            : 1;
    const normalizedFraction = value / basisPx;
    if (normalizedFraction <= smallMaxFraction) return 'small';
    if (normalizedFraction <= mediumMaxFraction) return 'medium';
    return 'large';
}

export function objectKeyCount(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return Object.keys(value as Record<string, unknown>).length;
}

export function serializeNormalizedPaneSizeWithBasisKey(
    basisKey: string,
    fallbackBasis: number,
    smallMaxFraction: number,
    mediumMaxFraction: number,
) {
    return (value: number, record?: Readonly<Record<string, unknown>>) =>
        bucketNormalizedPaneSize(value, record?.[basisKey] ?? fallbackBasis, smallMaxFraction, mediumMaxFraction);
}

export function serializeDesktopOverlayAutoHideDelayBucket(value: number): '3s' | '6s' | '10s' | '30s' {
    if (value <= 3_000) return '3s';
    if (value <= 6_000) return '6s';
    if (value <= 10_000) return '10s';
    return '30s';
}

export const paneDetailsTabSchema = z.object({
    key: z.string(),
    kind: z.string(),
    title: z.string(),
    subtitle: z.string().nullish(),
    resource: z.unknown(),
    isPreview: z.boolean(),
    isPinned: z.boolean(),
});

export const paneScopeStateSchema = z.object({
    right: z.object({
        isOpen: z.boolean(),
        activeTabId: z.string().nullable(),
        tabState: z.record(z.string(), z.unknown()),
    }),
    details: z.object({
        isOpen: z.boolean(),
        tabs: z.array(paneDetailsTabSchema),
        activeTabKey: z.string().nullable(),
        tabState: z.record(z.string(), z.unknown()),
    }),
    bottom: z.object({
        isOpen: z.boolean(),
        activeTabId: z.string().nullable(),
        tabState: z.record(z.string(), z.unknown()),
    }),
});
