import { z } from 'zod';

import { SessionListFilterV1Schema, type SessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';
import { WidgetInstanceRefV1Schema as InstanceRefSchema, WidgetInstanceV1Schema as InstanceSchema, WidgetInputBindingsV1Schema as BindingsSchema, type WidgetInstanceRefV1 } from '../widgets/widgetInstanceV1.js';
const WidgetInstanceRefV1Schema = z.lazy(() => InstanceRefSchema);
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
const WidgetInputBindingsV1Schema = z.lazy(() => BindingsSchema);
import { WidgetExpectedPresentationV1Schema, WidgetGridSizeV1Schema, WIDGET_SIZE_POLICY_V1 } from '../widgets/widgetPresentationV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

/**
 * Boards (INT §5.1): a user's own arrangement of live work — sessions, workflow runs, workflows and
 * machines — kept in a Board Artifact of the Home the board was created in.
 *
 * This module is the one owner of the board document: its schema, its normalization (references
 * deduplicated by qualified identity) and every edit (`applyWorkBoardIntentV1`). Writers replay an
 * intent against the current Artifact winner. Cards and status are projections
 * of their kinds' own owners and are never stored here.
 *
 * Named `WorkBoard` to stay apart from the per-session widget Board (`sessions/board/**`).
 */

export const WORK_BOARD_ITEM_KINDS_V1 = ['session', 'workflow_run', 'workflow', 'machine'] as const;
export type WorkBoardItemKindV1 = typeof WORK_BOARD_ITEM_KINDS_V1[number];

/** Smart sections: mixed-kind memberships read from existing owners (Inbox, active runs, machines). */
export const WORK_BOARD_SECTIONS_V1 = ['needs_you', 'running', 'my_machines'] as const;
export type WorkBoardSectionV1 = typeof WORK_BOARD_SECTIONS_V1[number];

export const WORK_BOARD_MODES_V1 = ['canvas', 'by_status'] as const;
export type WorkBoardModeV1 = typeof WORK_BOARD_MODES_V1[number];

const IdentifierSchema = z.string().trim().min(1);

/** A typed reference to one item on a Home. The same id on two Homes is two items. */
export const BoardItemRefV1Schema = z.object({
    kind: z.enum(WORK_BOARD_ITEM_KINDS_V1),
    qualifiedId: z.object({
        /** The Home's portable identity (its server identity id, or its profile id when it has none). */
        serverId: IdentifierSchema,
        id: IdentifierSchema,
    }).strict(),
}).strict();
const StoredBoardItemRefV1Schema = createStoredReadSchema(BoardItemRefV1Schema);
export type BoardItemRefV1 = Readonly<{
    kind: WorkBoardItemKindV1;
    qualifiedId: Readonly<{ serverId: string; id: string }>;
}>;

/** The one identity of a board item: dedupe key and `positionsByItemRef` key. */
export function buildWorkBoardItemKeyV1(ref: BoardItemRefV1): string {
    return JSON.stringify([ref.kind, ref.qualifiedId.serverId.trim(), ref.qualifiedId.id.trim()]);
}

export function readWorkBoardItemKeyV1(key: string): BoardItemRefV1 | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(key);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const ref = BoardItemRefV1Schema.safeParse({
        kind: parsed[0],
        qualifiedId: { serverId: parsed[1], id: parsed[2] },
    });
    return ref.success ? ref.data : null;
}

export const WorkBoardPositionV1Schema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
}).strict();
export type WorkBoardPositionV1 = Readonly<{ x: number; y: number }>;

export const WorkBoardWidgetSizeV1Schema = WidgetGridSizeV1Schema;
const defaultWidgetSize = WIDGET_SIZE_POLICY_V1.workBoard.defaultSize;
export const WorkBoardWidgetPlacementV1Schema = z.object({
    kind: z.literal('widget'), ref: WidgetInstanceRefV1Schema,
    instance: WidgetInstanceV1Schema, size: WorkBoardWidgetSizeV1Schema.default(defaultWidgetSize),
    frameStyle: z.enum(['card', 'plain']).optional(),
}).strict().refine(value => value.ref.surface.owner.kind === 'workBoard' && value.ref.instanceId === value.instance.id,
    'Widget placement must name its configured WorkBoard instance');
export type WorkBoardWidgetPlacementV1 = z.infer<typeof WorkBoardWidgetPlacementV1Schema>;

/** Qualified widget keys coexist with, and never change, existing work reference keys. */
export function buildWorkBoardWidgetKeyV1(ref: WidgetInstanceRefV1): string {
    const parsed = WidgetInstanceRefV1Schema.parse(ref);
    if (parsed.surface.owner.kind !== 'workBoard') throw new WorkBoardWidgetMutationErrorV1('widget_placement_unsupported');
    return JSON.stringify(['widget', parsed.surface.serverId, parsed.surface.accountId, parsed.surface.owner.boardId, parsed.instanceId]);
}
export function readWorkBoardWidgetKeyV1(key: string): WidgetInstanceRefV1 | null {
    let value: unknown;
    try { value = JSON.parse(key); } catch { return null; }
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 'widget') return null;
    const parsed = WidgetInstanceRefV1Schema.safeParse({ surface: { serverId: value[1], accountId: value[2],
        owner: { kind: 'workBoard', boardId: value[3] } }, instanceId: value[4] });
    return parsed.success ? parsed.data : null;
}
export class WorkBoardWidgetMutationErrorV1 extends Error {
    constructor(readonly code: 'widget_instance_not_found' | 'widget_instance_already_exists' | 'widget_instance_changed' | 'widget_placement_changed' | 'widget_placement_unsupported') {
        super(code); this.name = 'WorkBoardWidgetMutationErrorV1';
    }
}

export const WorkBoardSourceV1Schema = z.object({
    sections: z.array(z.enum(WORK_BOARD_SECTIONS_V1)).optional(),
    /** An inline Sessions filter (there is no separate saved-filter entity). */
    filter: SessionListFilterV1Schema.optional(),
    picked: z.array(BoardItemRefV1Schema).default([]),
}).strict();
export type WorkBoardSourceV1 = Readonly<{
    sections?: readonly WorkBoardSectionV1[];
    filter?: SessionListFilterV1;
    picked: readonly BoardItemRefV1[];
    /**
     * Sections and picked items this version does not know (a newer app's), never shown and written back
     * as they were so the newer app finds them again.
     */
    unknown?: WorkBoardUnknownSourceV1;
}>;

export type WorkBoardUnknownSourceV1 = Readonly<{ sections?: readonly string[]; picked?: readonly unknown[] }>;

/**
 * A stored board's source, read per value: a section or picked item this version does not know is set
 * aside in `unknown` (and re-tried there on every read), so a newer app's board still shows what this
 * version can draw.
 */
const StoredWorkBoardSourceV1Schema = createStoredReadSchema(z.object({
    sections: z.array(z.string()).optional(),
    filter: SessionListFilterV1Schema.optional(),
    picked: z.array(z.unknown()).default([]),
    unknown: z.object({
        sections: z.array(z.string()).optional(),
        picked: z.array(z.unknown()).optional(),
    }).strict().optional(),
}).strict().transform((source): WorkBoardSourceV1 => {
    const known = new Set<string>(WORK_BOARD_SECTIONS_V1);
    const sections: WorkBoardSectionV1[] = [];
    const unknownSections: string[] = [];
    if (source.sections !== undefined || source.unknown?.sections !== undefined) {
        for (const section of [...(source.sections ?? []), ...(source.unknown?.sections ?? [])]) {
            if (known.has(section)) sections.push(section as WorkBoardSectionV1);
            else unknownSections.push(section);
        }
    }
    const picked: BoardItemRefV1[] = [];
    const unknownPicked: unknown[] = [];
    for (const candidate of [...source.picked, ...(source.unknown?.picked ?? [])]) {
        const ref = StoredBoardItemRefV1Schema.safeParse(candidate);
        if (ref.success) picked.push(ref.data);
        else unknownPicked.push(candidate);
    }
    const unknown = {
        ...(unknownSections.length > 0 ? { sections: unknownSections } : {}),
        ...(unknownPicked.length > 0 ? { picked: unknownPicked } : {}),
    };
    return {
        ...(source.sections !== undefined || source.unknown?.sections !== undefined ? { sections } : {}),
        ...(source.filter ? { filter: source.filter } : {}),
        picked,
        ...(Object.keys(unknown).length > 0 ? { unknown } : {}),
    };
}));

export type WorkBoardV1 = Readonly<{
    id: string;
    name: string;
    source: WorkBoardSourceV1;
    mode: WorkBoardModeV1;
    snap: boolean;
    /** Canvas positions, kept while By status is shown; pruned when an item leaves the board. */
    positionsByItemRef: Readonly<Record<string, WorkBoardPositionV1>>;
    /** Shows the board at the top of the Sessions column. */
    pinnedInSessions: boolean;
    widgets?: readonly WorkBoardWidgetPlacementV1[];
    /** Mixed manually placed content order. Smart membership remains owned by its sources. */
    itemOrder?: readonly string[];
}>;

function dedupeBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
    const seen = new Set<string>();
    const next: T[] = [];
    for (const value of values) {
        const key = keyOf(value);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(value);
    }
    return next;
}

function normalizePosition(position: WorkBoardPositionV1): WorkBoardPositionV1 {
    return { x: Math.round(position.x), y: Math.round(position.y) };
}

function normalizeSource(source: WorkBoardSourceV1): WorkBoardSourceV1 {
    return {
        ...(source.sections ? { sections: dedupeBy(source.sections, (section) => section) } : {}),
        ...(source.filter ? { filter: source.filter } : {}),
        picked: dedupeBy(
            source.picked.map((ref) => ({
                kind: ref.kind,
                qualifiedId: { serverId: ref.qualifiedId.serverId.trim(), id: ref.qualifiedId.id.trim() },
            })),
            buildWorkBoardItemKeyV1,
        ),
        ...(source.unknown ? { unknown: source.unknown } : {}),
    };
}

function normalizePositions(
    positions: Readonly<Record<string, WorkBoardPositionV1>>,
): Record<string, WorkBoardPositionV1> {
    const next: Record<string, WorkBoardPositionV1> = {};
    for (const [key, position] of Object.entries(positions)) {
        const ref = readWorkBoardItemKeyV1(key);
        const widget = readWorkBoardWidgetKeyV1(key);
        if (!ref && !widget) continue;
        next[ref ? buildWorkBoardItemKeyV1(ref) : buildWorkBoardWidgetKeyV1(widget!)] = normalizePosition(position);
    }
    return next;
}

function normalizeWorkBoardV1(board: WorkBoardV1): WorkBoardV1 {
    return {
        id: board.id,
        name: board.name,
        source: normalizeSource(board.source),
        mode: board.mode,
        snap: board.snap,
        positionsByItemRef: normalizePositions(board.positionsByItemRef),
        pinnedInSessions: board.pinnedInSessions,
        ...(board.widgets ? { widgets: board.widgets } : {}),
        ...(board.itemOrder || board.widgets?.length ? { itemOrder: resolveWorkBoardItemOrderV1(board) } : {}),
    };
}

const WorkBoardFieldsV1Schema = z.object({
    id: IdentifierSchema,
    name: z.string().trim().min(1),
    source: WorkBoardSourceV1Schema.extend({
        unknown: z.object({
            sections: z.array(z.string()).optional(),
            picked: z.array(z.unknown()).optional(),
        }).strict().optional(),
    }),
    mode: z.enum(WORK_BOARD_MODES_V1).default('canvas'),
    snap: z.boolean().default(true),
    positionsByItemRef: z.record(z.string(), WorkBoardPositionV1Schema).default({}),
    pinnedInSessions: z.boolean().default(false),
    widgets: z.array(WorkBoardWidgetPlacementV1Schema).optional(),
    itemOrder: z.array(z.string()).optional(),
}).strict();

function validateWorkBoardWidgetsV1(board: Pick<WorkBoardV1, 'id' | 'widgets'>, context: z.RefinementCtx): void {
    const keys = new Set<string>();
    for (const placement of board.widgets ?? []) {
        if (placement.ref.surface.owner.kind !== 'workBoard' || placement.ref.surface.owner.boardId !== board.id) {
            context.addIssue({ code: 'custom', path: ['widgets'], message: 'Widget belongs to another Board' });
            continue;
        }
        const key = buildWorkBoardWidgetKeyV1(placement.ref);
        if (keys.has(key)) context.addIssue({ code: 'custom', path: ['widgets'], message: 'Duplicate widget placement' });
        keys.add(key);
    }
}
/** Closed output contract over the canonical normalized Board shape. */
export const WorkBoardV1StrictSchema = WorkBoardFieldsV1Schema
    .superRefine(validateWorkBoardWidgetsV1)
    .transform((board): WorkBoardV1 => normalizeWorkBoardV1(board));
/** Stored Board reads drop extra fields while retaining the canonical validation and normalization. */
export const WorkBoardV1Schema = createStoredReadSchema(WorkBoardFieldsV1Schema
    .extend({ source: StoredWorkBoardSourceV1Schema })
    .superRefine(validateWorkBoardWidgetsV1)
    .transform((board): WorkBoardV1 => normalizeWorkBoardV1(board)));

export function resolveWorkBoardItemOrderV1(board: WorkBoardV1): string[] {
    const keys = [...board.source.picked.map(buildWorkBoardItemKeyV1), ...(board.widgets ?? []).map(item => buildWorkBoardWidgetKeyV1(item.ref))];
    const known = new Set(keys);
    return dedupeBy([...(board.itemOrder ?? []).filter(key => known.has(key)), ...keys], key => key);
}

/**
 * An in-memory collection of the boards created in this Home.
 *
 * Read per board: one this version cannot read (a newer app's shape, or a damaged one) never breaks
 * the collection. It is kept in `unreadable` exactly as stored — not shown, written back
 * untouched, and re-tried on every read — and is never reinterpreted as "no boards".
 */
export const WorkBoardsV1Schema = z.object({
    v: z.literal(1).default(1),
    boards: z.array(z.unknown()).default([]),
    unreadable: z.array(z.unknown()).optional(),
}).strip().transform((value): WorkBoardsV1 => {
    const boards: WorkBoardV1[] = [];
    const unreadable: unknown[] = [];
    for (const candidate of [...value.boards, ...(value.unreadable ?? [])]) {
        const board = WorkBoardV1Schema.safeParse(candidate);
        if (board.success) boards.push(board.data);
        else unreadable.push(candidate);
    }
    return {
        v: 1,
        boards: dedupeBy(boards, (board) => board.id),
        ...(unreadable.length > 0 ? { unreadable } : {}),
    };
});
export type WorkBoardsV1 = Readonly<{
    v: 1;
    boards: readonly WorkBoardV1[];
    /** Boards this version cannot read, as stored; never shown, always written back. */
    unreadable?: readonly unknown[];
}>;

/** Fresh schema input; parsed Board documents remain readonly. */
export function createDefaultWorkBoardsV1(): z.input<typeof WorkBoardsV1Schema> {
    return { v: 1, boards: [] };
}

const defaultWorkBoardsV1 = WorkBoardsV1Schema.parse(createDefaultWorkBoardsV1());
export const DEFAULT_WORK_BOARDS_V1: WorkBoardsV1 = Object.freeze({
    ...defaultWorkBoardsV1,
    boards: Object.freeze(defaultWorkBoardsV1.boards),
});

/** A new board: hand-picked and empty, on Canvas with snapping on, not pinned in Sessions. */
export function createWorkBoardV1(input: Readonly<{ id: string; name: string }>): WorkBoardV1 {
    return {
        id: input.id.trim(),
        name: input.name.trim(),
        source: { picked: [] },
        mode: 'canvas',
        snap: true,
        positionsByItemRef: {},
        pinnedInSessions: false,
    };
}

/**
 * What is on a board right now, as its writer last saw it. A position survives when its item is
 * picked, is a live member of a section or filter, or belongs to a Home that is not mounted (an
 * unavailable Home's items are never deleted).
 */
export type WorkBoardMembershipV1 = Readonly<{
    liveItemKeys: readonly string[];
    unavailableServerIds: readonly string[];
}>;

export function pruneWorkBoardPositionsV1(board: WorkBoardV1, membership: WorkBoardMembershipV1): WorkBoardV1 {
    const kept = new Set([...board.source.picked.map(buildWorkBoardItemKeyV1), ...(board.widgets ?? []).map(item => buildWorkBoardWidgetKeyV1(item.ref)), ...membership.liveItemKeys]);
    const unavailable = new Set(membership.unavailableServerIds.map((serverId) => serverId.trim()));
    const positionsByItemRef: Record<string, WorkBoardPositionV1> = {};
    let changed = false;
    for (const [key, position] of Object.entries(board.positionsByItemRef)) {
        const ref = readWorkBoardItemKeyV1(key);
        if (kept.has(key) || (ref && unavailable.has(ref.qualifiedId.serverId))) {
            positionsByItemRef[key] = position;
        } else {
            changed = true;
        }
    }
    return changed ? { ...board, positionsByItemRef } : board;
}

export type WorkBoardSettingsPatchV1 = Partial<Pick<WorkBoardV1, 'name' | 'mode' | 'snap' | 'pinnedInSessions'>> & Readonly<{
    /** Omitted settings stay unchanged; null explicitly clears a section or filter selection. */
    source?: Readonly<{
        sections?: readonly WorkBoardSectionV1[] | null;
        filter?: SessionListFilterV1 | null;
        picked?: readonly BoardItemRefV1[];
    }>;
}>;

/** Every edit a board can receive. Writers replay one intent against the current Artifact winner. */
export type WorkBoardIntentV1 =
    | WorkBoardWidgetIntentV1
    | Readonly<{ kind: 'create'; board: Readonly<{ id: string; name: string }> }>
    | Readonly<{ kind: 'delete'; boardId: string }>
    | Readonly<{ kind: 'update'; boardId: string; patch: WorkBoardSettingsPatchV1 }>
    | Readonly<{
        kind: 'add_items';
        boardId: string;
        refs: readonly BoardItemRefV1[];
        /** Places the added items (⌘↵ "Add and place"); absent items take the first free slot. */
        positionsByItemRef?: Readonly<Record<string, WorkBoardPositionV1>>;
    }>
    | Readonly<{
        kind: 'remove_item';
        boardId: string;
        ref: BoardItemRefV1;
        /**
         * The board's live membership, from a writer that has it (the UI). The removed pick's place survives
         * while a section or the filter still holds the item; without it (an agent), a board with a section or
         * filter keeps the place and a hand-picked board drops it.
         */
        membership?: WorkBoardMembershipV1;
    }>
    | Readonly<{
        kind: 'set_positions';
        boardId: string;
        positionsByItemRef: Readonly<Record<string, WorkBoardPositionV1>>;
        /** UI writers can prune with live membership; agents omit it and only move positions. */
        membership?: WorkBoardMembershipV1;
    }>;

const WorkBoardMembershipV1Schema = z.object({
    liveItemKeys: z.array(z.string()),
    unavailableServerIds: z.array(IdentifierSchema),
}).strict();

const widgetTarget = { boardId: IdentifierSchema, ref: WidgetInstanceRefV1Schema };
export const WorkBoardWidgetIntentV1Schema = z.discriminatedUnion('kind', [
    z.object({ ...widgetTarget, kind: z.literal('widget_add'), instance: WidgetInstanceV1Schema,
        size: WorkBoardWidgetSizeV1Schema.optional(), frameStyle: z.enum(['card', 'plain']).optional(),
        toIndex: z.number().int().nonnegative().optional(), nativeIndex: z.number().int().nonnegative().optional(),
        position: WorkBoardPositionV1Schema.optional() }).strict(),
    z.object({ ...widgetTarget, kind: z.literal('widget_remove'), expectedInstance: WidgetInstanceV1Schema.optional(),
        expectedPresentation: WidgetExpectedPresentationV1Schema.optional() }).strict(),
    z.object({ ...widgetTarget, kind: z.literal('widget_move'), toIndex: z.number().int().nonnegative().optional(),
        nativeIndex: z.number().int().nonnegative().optional() }).strict().refine(value => (value.toIndex === undefined) !== (value.nativeIndex === undefined)),
    z.object({ ...widgetTarget, kind: z.literal('widget_size'), size: WorkBoardWidgetSizeV1Schema }).strict(),
    z.object({ ...widgetTarget, kind: z.literal('widget_frame'), frameStyle: z.enum(['card', 'plain']).nullable() }).strict(),
    z.object({ ...widgetTarget, kind: z.literal('widget_rename'), displayName: IdentifierSchema.nullable() }).strict(),
    z.object({ ...widgetTarget, kind: z.literal('widget_inputs'), bindings: WidgetInputBindingsV1Schema }).strict(),
]);
export type WorkBoardWidgetIntentV1 = z.infer<typeof WorkBoardWidgetIntentV1Schema>;

/** Wire validation shares the UI owner's intent vocabulary, rather than a second edit model. */
export const WorkBoardIntentV1Schema = z.discriminatedUnion('kind', [
    ...WorkBoardWidgetIntentV1Schema.options,
    z.object({ kind: z.literal('create'), board: z.object({
        id: IdentifierSchema, name: z.string().trim().min(1),
    }).strict() }).strict(),
    z.object({ kind: z.literal('delete'), boardId: IdentifierSchema }).strict(),
    z.object({ kind: z.literal('update'), boardId: IdentifierSchema, patch: z.object({
        name: z.string().trim().min(1).optional(), mode: z.enum(WORK_BOARD_MODES_V1).optional(),
        snap: z.boolean().optional(), pinnedInSessions: z.boolean().optional(),
        // Do not apply the persisted source's picked default to a partial edit.
        source: z.object({
            sections: WorkBoardSourceV1Schema.shape.sections.nullable(),
            filter: WorkBoardSourceV1Schema.shape.filter.nullable(),
            picked: z.array(BoardItemRefV1Schema).optional(),
        }).strict().optional(),
    }).strict() }).strict(),
    z.object({ kind: z.literal('add_items'), boardId: IdentifierSchema, refs: z.array(BoardItemRefV1Schema),
        positionsByItemRef: z.record(z.string(), WorkBoardPositionV1Schema).optional(),
    }).strict(),
    z.object({ kind: z.literal('remove_item'), boardId: IdentifierSchema, ref: BoardItemRefV1Schema,
        membership: WorkBoardMembershipV1Schema.optional(),
    }).strict(),
    z.object({ kind: z.literal('set_positions'), boardId: IdentifierSchema,
        positionsByItemRef: z.record(z.string(), WorkBoardPositionV1Schema),
        membership: WorkBoardMembershipV1Schema.optional(),
    }).strict(),
]);

export type WorkBoardIntentResultV1 =
    | Readonly<{ status: 'applied'; boards: WorkBoardsV1 }>
    | Readonly<{ status: 'not_found' }>;

function replaceBoard(
    boards: WorkBoardsV1,
    boardId: string,
    edit: (board: WorkBoardV1) => WorkBoardV1,
): WorkBoardIntentResultV1 {
    const index = boards.boards.findIndex((board) => board.id === boardId);
    if (index < 0) return { status: 'not_found' };
    const next = [...boards.boards];
    next[index] = WorkBoardV1Schema.parse(edit(boards.boards[index]!));
    return { status: 'applied', boards: { ...boards, boards: next } };
}

export function applyWorkBoardIntentV1(boards: WorkBoardsV1, intent: WorkBoardIntentV1): WorkBoardIntentResultV1 {
    if ('ref' in intent && intent.kind.startsWith('widget_')) {
        return applyWorkBoardWidgetIntentV1(boards, intent as WorkBoardWidgetIntentV1);
    }
    switch (intent.kind) {
        case 'create':
            return {
                status: 'applied',
                boards: WorkBoardsV1Schema.parse({ ...boards, boards: [...boards.boards, createWorkBoardV1(intent.board)] }),
            };
        case 'delete': {
            if (!boards.boards.some((board) => board.id === intent.boardId)) return { status: 'not_found' };
            return { status: 'applied', boards: { ...boards, boards: boards.boards.filter((board) => board.id !== intent.boardId) } };
        }
        case 'update':
            return replaceBoard(boards, intent.boardId, (board) => {
                const { source, ...rest } = intent.patch;
                return {
                    ...board,
                    ...rest,
                    ...(source ? {
                        source: {
                            ...board.source,
                            ...(source.sections !== undefined ? { sections: source.sections ?? undefined } : {}),
                            ...(source.filter !== undefined ? { filter: source.filter ?? undefined } : {}),
                            picked: source.picked ?? board.source.picked,
                        },
                    } : {}),
                };
            });
        case 'add_items':
            return replaceBoard(boards, intent.boardId, (board) => ({
                ...board,
                source: { ...board.source, picked: [...board.source.picked, ...intent.refs] },
                positionsByItemRef: { ...board.positionsByItemRef, ...intent.positionsByItemRef },
            }));
        case 'remove_item': {
            const removedKey = buildWorkBoardItemKeyV1(intent.ref);
            return replaceBoard(boards, intent.boardId, (board) => {
                const unpicked: WorkBoardV1 = {
                    ...board,
                    source: {
                        ...board.source,
                        picked: board.source.picked.filter((ref) => buildWorkBoardItemKeyV1(ref) !== removedKey),
                    },
                };
                if (intent.membership) return pruneWorkBoardPositionsV1(unpicked, intent.membership);
                const sourced = (board.source.sections?.length ?? 0) > 0 || board.source.filter !== undefined;
                if (sourced) return unpicked;
                const positionsByItemRef = { ...board.positionsByItemRef };
                delete positionsByItemRef[removedKey];
                return { ...unpicked, positionsByItemRef };
            });
        }
        case 'set_positions':
            return replaceBoard(boards, intent.boardId, (board) => {
                const moved = { ...board, positionsByItemRef: { ...board.positionsByItemRef, ...intent.positionsByItemRef } };
                return intent.membership ? pruneWorkBoardPositionsV1(moved, intent.membership) : moved;
            });
    }
    throw new Error('Unsupported Board intent');
}

function applyWorkBoardWidgetIntentV1(boards: WorkBoardsV1, intent: WorkBoardWidgetIntentV1): WorkBoardIntentResultV1 {
    if (intent.ref.surface.owner.kind !== 'workBoard' || intent.ref.surface.owner.boardId !== intent.boardId) {
        throw new WorkBoardWidgetMutationErrorV1('widget_placement_unsupported');
    }
    const key = buildWorkBoardWidgetKeyV1(intent.ref);
    return replaceBoard(boards, intent.boardId, board => {
        const widgets = [...(board.widgets ?? [])];
        const index = widgets.findIndex(item => buildWorkBoardWidgetKeyV1(item.ref) === key);
        const current = widgets[index];
        let itemOrder = resolveWorkBoardItemOrderV1(board);
        const insert = (nativeIndex?: number, ordinal?: number) => {
            const remaining = itemOrder.filter(item => item !== key);
            const widgetKeys = new Set(widgets.filter(item => buildWorkBoardWidgetKeyV1(item.ref) !== key).map(item => buildWorkBoardWidgetKeyV1(item.ref)));
            const anchor = ordinal === undefined ? undefined : remaining.filter(item => widgetKeys.has(item))[ordinal];
            const at = nativeIndex ?? (anchor ? remaining.indexOf(anchor) : remaining.length);
            remaining.splice(at, 0, key); itemOrder = remaining;
        };
        if (intent.kind === 'widget_add') {
            if (current) throw new WorkBoardWidgetMutationErrorV1('widget_instance_already_exists');
            if (intent.instance.id !== intent.ref.instanceId) throw new WorkBoardWidgetMutationErrorV1('widget_placement_unsupported');
            widgets.push({ kind: 'widget', ref: intent.ref, instance: intent.instance, size: intent.size ?? defaultWidgetSize,
                ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}) });
            insert(intent.nativeIndex, intent.toIndex);
            return { ...board, widgets, itemOrder, positionsByItemRef: { ...board.positionsByItemRef,
                ...(intent.position ? { [key]: intent.position } : {}) } };
        }
        if (!current) throw new WorkBoardWidgetMutationErrorV1('widget_instance_not_found');
        switch (intent.kind) {
            case 'widget_remove': {
                if (intent.expectedInstance && !sameStrictJsonValue(current.instance, intent.expectedInstance)) throw new WorkBoardWidgetMutationErrorV1('widget_instance_changed');
                if (intent.expectedPresentation && !sameStrictJsonValue(intent.expectedPresentation, {
                    nativeIndex: itemOrder.indexOf(key), size: current.size, frameStyle: current.frameStyle ?? null,
                    ...(intent.expectedPresentation.canvasPosition !== undefined ? { canvasPosition: board.positionsByItemRef[key]
                        ? [board.positionsByItemRef[key]!.x, board.positionsByItemRef[key]!.y] : null } : {}),
                })) throw new WorkBoardWidgetMutationErrorV1('widget_placement_changed');
                widgets.splice(index, 1); itemOrder = itemOrder.filter(item => item !== key);
                const positionsByItemRef = { ...board.positionsByItemRef }; delete positionsByItemRef[key];
                return { ...board, widgets, itemOrder, positionsByItemRef };
            }
            case 'widget_move': insert(intent.nativeIndex, intent.toIndex); break;
            case 'widget_size': widgets[index] = { ...current, size: intent.size }; break;
            case 'widget_frame': {
                const { frameStyle: _old, ...rest } = current;
                widgets[index] = { ...rest, ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}) }; break;
            }
            case 'widget_rename': {
                const { displayName: _old, ...rest } = current.instance;
                widgets[index] = { ...current, instance: { ...rest, ...(intent.displayName ? { displayName: intent.displayName } : {}) } }; break;
            }
            case 'widget_inputs': widgets[index] = { ...current, instance: { ...current.instance, bindings: intent.bindings } }; break;
        }
        return { ...board, widgets, itemOrder };
    });
}
