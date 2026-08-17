import { z } from 'zod';
import { SelectedPaneDestinationV1Schema } from '@/components/appShell/panes/model/selectedPaneDestination';

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

/**
 * Zod's record parser skips prototype-named object keys. Details tabs and
 * groups intentionally accept arbitrary string identifiers, so parse their
 * own enumerable entries and rebuild an exact-own-key record instead.
 */
function toOwnRecordEntriesInput(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return { entries: Object.entries(value) };
}

const paneDetailsTabStateRecordSchema = z.preprocess(
    toOwnRecordEntriesInput,
    z.object({
        entries: z.array(z.tuple([z.string(), z.unknown()])),
    }).transform(({ entries }) => Object.fromEntries(entries)),
);

const paneDetailsTabsByKeySchema = z.preprocess(
    toOwnRecordEntriesInput,
    z.object({
        entries: z.array(z.tuple([z.string(), paneDetailsTabSchema])),
    }).transform(({ entries }) => Object.fromEntries(entries)),
);

const legacyPaneDetailsStateSchema = z.object({
    isOpen: z.boolean(),
    tabs: z.array(paneDetailsTabSchema),
    activeTabKey: z.string().nullable(),
    tabState: paneDetailsTabStateRecordSchema,
});

const detailsWorkspaceNodeSchema: z.ZodType<unknown> = z.lazy(() => z.union([
    z.object({
        id: z.string(),
        kind: z.literal('leaf'),
        leafKind: z.literal('details-group'),
        payload: z.object({
            groupId: z.string(),
        }),
    }),
    z.object({
        id: z.string(),
        kind: z.literal('split'),
        axis: z.enum(['row', 'column']),
        ratio: z.number(),
        first: detailsWorkspaceNodeSchema,
        second: detailsWorkspaceNodeSchema,
    }),
]));

const detailsWorkspaceGroupSchema = z.object({
    id: z.string(),
    tabKeys: z.array(z.string()),
    activeTabKey: z.string().nullable(),
});

const paneDetailsGroupsByIdSchema = z.preprocess(
    toOwnRecordEntriesInput,
    z.object({
        entries: z.array(z.tuple([z.string(), detailsWorkspaceGroupSchema])),
    }).transform(({ entries }) => Object.fromEntries(entries)),
);

export const paneDetailsWorkspaceStateSchema = z.object({
    isOpen: z.boolean(),
    tabState: paneDetailsTabStateRecordSchema,
    tabsByKey: paneDetailsTabsByKeySchema,
    groupsById: paneDetailsGroupsByIdSchema,
    root: detailsWorkspaceNodeSchema.nullable(),
    focusedGroupId: z.string().nullable(),
    maximizedGroupId: z.string().nullable(),
    nextGroupOrdinal: z.number().int().positive(),
    // This boundary preserves the opaque persisted candidate for the canonical
    // Details migration below. That migration accepts only qualified identity
    // and return facts, so hostile launch/currentness fields drop the overlay
    // without invalidating the containing scope or its retained tab groups.
    overlay: z.unknown().optional(),
});

const paneSlotStateSchema = z.object({
    isOpen: z.boolean(),
    activeTabId: z.string().nullable(),
    // Destination identity is the one plugin-owned fact in an otherwise
    // host-owned pane slot. A stale or malformed plugin selection must not
    // discard the scope's valid built-in layout/details workspace; retain the
    // slot and let AppPane use its incumbent built-in selection instead.
    selectedDestination: SelectedPaneDestinationV1Schema.nullable().default(null).catch(null),
    tabState: paneDetailsTabStateRecordSchema,
});

export const paneScopeStateSchema = z.object({
    right: paneSlotStateSchema,
    details: z.union([legacyPaneDetailsStateSchema, paneDetailsWorkspaceStateSchema]),
    bottom: paneSlotStateSchema,
});

/**
 * A malformed scope is isolated at the local-setting record boundary instead
 * of invalidating unrelated pane layouts. Legacy entries intentionally use the
 * old details shape; AppPaneProvider performs the one existing workspace
 * migration after this schema boundary.
 */
export const EMPTY_PERSISTED_PANE_SCOPE_STATE = Object.freeze({
    right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
    details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
    bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
});
