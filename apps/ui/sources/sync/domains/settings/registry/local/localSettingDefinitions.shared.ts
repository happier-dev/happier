import { z } from 'zod/mini';
import { SelectedPaneDestinationV1Schema } from '@/components/appShell/panes/model/selectedPaneDestination';

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


export const paneDetailsTabSchema = z.object({
    key: z.string(),
    kind: z.string(),
    title: z.string(),
    subtitle: z.nullish(z.string()),
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

const paneDetailsTabStateRecordSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(toOwnRecordEntriesInput), z.pipe(z.object({
        entries: z.array(z.tuple([z.string(), z.unknown()])),
    }), z.transform(({ entries }) => Object.fromEntries(entries))));

const paneDetailsTabsByKeySchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(toOwnRecordEntriesInput), z.pipe(z.object({
        entries: z.array(z.tuple([z.string(), paneDetailsTabSchema])),
    }), z.transform(({ entries }) => Object.fromEntries(entries))));

const legacyPaneDetailsStateSchema = z.object({
    isOpen: z.boolean(),
    tabs: z.array(paneDetailsTabSchema),
    activeTabKey: z.nullable(z.string()),
    tabState: paneDetailsTabStateRecordSchema,
});

const detailsWorkspaceNodeSchema: z.ZodMiniType<unknown> = z.lazy(() => z.union([
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
    activeTabKey: z.nullable(z.string()),
});

const paneDetailsGroupsByIdSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(toOwnRecordEntriesInput), z.pipe(z.object({
        entries: z.array(z.tuple([z.string(), detailsWorkspaceGroupSchema])),
    }), z.transform(({ entries }) => Object.fromEntries(entries))));

export const paneDetailsWorkspaceStateSchema = z.object({
    isOpen: z.boolean(),
    tabState: paneDetailsTabStateRecordSchema,
    tabsByKey: paneDetailsTabsByKeySchema,
    groupsById: paneDetailsGroupsByIdSchema,
    root: z.nullable(detailsWorkspaceNodeSchema),
    focusedGroupId: z.nullable(z.string()),
    maximizedGroupId: z.nullable(z.string()),
    nextGroupOrdinal: z.number().check(z.int(), z.positive()),
    // This boundary preserves the opaque persisted candidate for the canonical
    // Details migration below. That migration accepts only qualified identity
    // and return facts, so hostile launch/currentness fields drop the overlay
    // without invalidating the containing scope or its retained tab groups.
    overlay: z.optional(z.unknown()),
});

const paneSlotStateSchema = z.object({
    isOpen: z.boolean(),
    activeTabId: z.nullable(z.string()),
    // Destination identity is the one plugin-owned fact in an otherwise
    // host-owned pane slot. A stale or malformed plugin selection must not
    // discard the scope's valid built-in layout/details workspace; retain the
    // slot and let AppPane use its incumbent built-in selection instead.
    selectedDestination: z.catch(z._default(z.nullable(SelectedPaneDestinationV1Schema), null), null),
    tabState: paneDetailsTabStateRecordSchema,
});

export const paneScopeStateSchema = z.object({
    mainHidden: z._default(z.boolean(), false),
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
    mainHidden: false,
    right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
    details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
    bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
});
