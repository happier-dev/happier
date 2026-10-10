import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sha1 } from '@noble/hashes/sha1';
import { bytesToHex } from '@noble/hashes/utils';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { generateKeyBetween } from 'fractional-indexing';
import type { HomeHubArtifactTransportV1, HomeHubArtifactV1 } from '../home/homeHubArtifactV1.js';
import type { WorkBoardArtifactTransportV1, WorkBoardArtifactRevisionV1 } from '../boards/workBoardArtifactV1.js';
import { ArtifactCallerAccessV1Schema, type ArtifactCallerAccessV1 } from '../artifacts/artifactAccessV1.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactActionsV1.js';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '../actions/anchoredListOrderV1.js';
import { getWidgetSharedInputIssuesV1 } from './widgetSharedInputAdmissionV1.js';
import { WidgetInstanceV1Schema, WidgetSurfaceRefV1Schema, type WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { WidgetExpectedPresentationV1Schema, type WidgetActionSurfacePortV1, type WidgetSurfaceMutationV1, type WidgetMoveCaptureV1 } from './actionsV1.js';
import { WidgetGridSizeV1Schema, WidgetProjectAreaV1Schema, normalizeWidgetSizeForSurfaceV1 } from './widgetPresentationV1.js';
import { projectOverviewDefaultPlacementsV1 } from './builtinWidgetDescriptorV1.js';
import { WidgetLayoutItemV1Schema, type WidgetLayoutItemV1, WidgetLayoutItemsV1Schema, WidgetLayoutItemIntentV1Schema, applyWidgetLayoutItemIntentV1, findWidgetLayoutItemV1, findWidgetLayoutParentV1, flattenWidgetLayoutWidgetsV1, getWidgetLayoutItemIdV1 } from './widgetLayoutItemV1.js';

export const WIDGET_SURFACE_ARTIFACT_KIND_V1 = 'widget-area-layout.v1';
export const WidgetAreaSurfaceRefV1Schema = lazyZodSchema(() => WidgetSurfaceRefV1Schema.refine(surface => surface.owner.kind === 'project' || surface.owner.kind === 'pluginArea' || surface.owner.kind === 'corePage', 'Personal area required'));
export const WidgetAreaLayoutV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1), surface: WidgetAreaSurfaceRefV1Schema, name: z.string().trim().min(1).optional(),
    items: WidgetLayoutItemsV1Schema,
}).strict());
export type WidgetAreaLayoutV1 = z.infer<typeof WidgetAreaLayoutV1Schema>;
export const WidgetAreaLayoutV1StoredSchema = createStoredReadSchema(WidgetAreaLayoutV1Schema);
/** Host-owned defaults, passed by the page owner; never an Action-request layout authority. */
export const WidgetAreaPresetV1Schema = lazyZodSchema(() => z.object({
    id: z.string().trim().min(1), name: z.string().trim().min(1), items: WidgetLayoutItemsV1Schema,
}).strict());
export type WidgetAreaPresetV1 = z.input<typeof WidgetAreaPresetV1Schema>;
/**
 * One thing an edited layout differs from its preset by. `item` is the layout's own item, or, for a
 * removed one, the preset's (it is no longer in the layout, and a reader still has to name it).
 */
export const WidgetAreaPresetChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('renamed') }).strict(),
    z.object({ kind: z.literal('added'), item: WidgetLayoutItemV1Schema }).strict(),
    z.object({ kind: z.literal('removed'), item: WidgetLayoutItemV1Schema }).strict(),
    z.object({ kind: z.literal('moved'), item: WidgetLayoutItemV1Schema, direction: z.enum(['up', 'down']) }).strict(),
    z.object({ kind: z.literal('changed'), item: WidgetLayoutItemV1Schema }).strict(),
]));
export type WidgetAreaPresetChangeV1 = z.infer<typeof WidgetAreaPresetChangeV1Schema>;
export const WidgetAreaPresetStateV1Schema = lazyZodSchema(() => z.object({
    id: z.string().trim().min(1), name: z.string().trim().min(1), isEdited: z.boolean(),
    /** What the edit changed, in the layout's order; empty exactly when `isEdited` is false. */
    changes: z.array(WidgetAreaPresetChangeV1Schema).default([]),
}).strict());
export type WidgetAreaPresetStateV1 = z.infer<typeof WidgetAreaPresetStateV1Schema>;
export const WidgetAreaPresetUndoV1Schema = lazyZodSchema(() => z.object({
    surface: WidgetAreaSurfaceRefV1Schema, previousLayout: WidgetAreaLayoutV1Schema, expectedRevision: ArtifactRevisionV1Schema,
}).strict());
export type WidgetAreaPresetUndoV1 = z.infer<typeof WidgetAreaPresetUndoV1Schema>;
export const WidgetAreaPresetResultV1Schema = lazyZodSchema(() => z.object({
    surface: WidgetAreaSurfaceRefV1Schema, layout: WidgetAreaLayoutV1Schema, undo: WidgetAreaPresetUndoV1Schema.optional(),
}).strict());
export type WidgetAreaPresetResultV1 = z.infer<typeof WidgetAreaPresetResultV1Schema>;
const instanceId = WidgetInstanceV1Schema.shape.id;
const index = z.number().int().nonnegative().safe();
export const WidgetAreaLayoutIntentV1Schema = lazyZodSchema(() => z.union([
    WidgetLayoutItemIntentV1Schema,
    z.object({ kind: z.literal('remove'), instanceId, expectedInstance: WidgetInstanceV1Schema.optional(), expectedPresentation: WidgetExpectedPresentationV1Schema.optional() }).strict(),
    z.object({ kind: z.literal('move'), instanceId, area: WidgetProjectAreaV1Schema.optional(), groupId: z.string().min(1).nullable().optional(), toIndex: index,
        expectedInstance: WidgetInstanceV1Schema.optional(), expectedPresentation: WidgetExpectedPresentationV1Schema.optional() }).strict(),
]));
export type WidgetAreaLayoutIntentV1 = z.infer<typeof WidgetAreaLayoutIntentV1Schema>;
export class WidgetAreaMutationErrorV1 extends Error {
    constructor(readonly code: string) { super(code); this.name = 'WidgetAreaMutationErrorV1'; }
}
function storedSurface(raw: WidgetSurfaceRefV1): WidgetSurfaceRefV1 {
    const { artifactId: _binding, ...surface } = WidgetAreaSurfaceRefV1Schema.parse(raw);
    return surface;
}
export function projectOverviewPresetV1(): WidgetAreaPresetV1 {
    return { id: 'overview', name: 'Overview', items: projectOverviewDefaultPlacementsV1() };
}
/** Page metadata is host-owned; this lookup never accepts a caller-supplied preset. */
export function resolveWidgetAreaPresetV1<T extends WidgetAreaPresetV1>(surface: WidgetSurfaceRefV1, presets?: readonly T[]): T | undefined {
    const layoutId = surface.owner.kind === 'project' ? surface.owner.layoutId ?? 'overview'
        : surface.owner.kind === 'corePage' || surface.owner.kind === 'pluginArea' ? surface.owner.layoutId : undefined;
    return presets?.find(preset => preset.id === layoutId);
}
/** Inventory and first personalization derive the same initial order from host metadata. */
function hostLayouts(surface: WidgetSurfaceRefV1, raw?: readonly WidgetAreaPresetV1[]) {
    let sortKey: string | null = null;
    const layouts = (raw ?? (surface.owner.kind === 'project' ? [projectOverviewPresetV1()] : [])).map(value => {
        const preset = WidgetAreaPresetV1Schema.parse(value);
        sortKey = generateKeyBetween(sortKey, null);
        return { ...preset, sortKey };
    });
    if (new Set(layouts.map(value => value.id)).size !== layouts.length) throw new WidgetAreaMutationErrorV1('widget_area_preset_mismatch');
    return layouts;
}
function missingAreaLayout(surface: WidgetSurfaceRefV1, preset?: z.output<typeof WidgetAreaPresetV1Schema>): WidgetAreaLayoutV1 {
    return { v: 1, surface: storedSurface(surface), ...(preset ? { name: preset.name } : {}), items: preset?.items ?? [] };
}
function isWidgetAreaPresetEdited(layout: WidgetAreaLayoutV1, preset: z.output<typeof WidgetAreaPresetV1Schema> | undefined): boolean {
    return !!preset && (layout.name !== preset.name || !sameStrictJsonValue(layout.items, preset.items));
}
type PresetEntry = Readonly<{ id: string; item: WidgetLayoutItemV1; parentId: string | null; own: unknown }>;
/** Every item in reading order, with what it is apart from where it sits (a group without its children). */
function presetEntries(items: readonly WidgetLayoutItemV1[]): PresetEntry[] {
    return items.flatMap((item): PresetEntry[] => {
        if (item.kind === 'widget') return [{ id: item.instance.id, item, parentId: null, own: item }];
        const { children, ...own } = item;
        return [{ id: item.id, item, parentId: null, own },
            ...children.map((child): PresetEntry => ({ id: child.instance.id, item: child, parentId: item.id, own: child }))];
    });
}
/** The ids, in `order`, that kept their relative order in `reference` (a longest common subsequence). */
function settledIds(order: readonly string[], reference: readonly string[]): ReadonlySet<string> {
    const lengths = order.map(() => reference.map(() => 0));
    for (let a = order.length - 1; a >= 0; a -= 1) for (let b = reference.length - 1; b >= 0; b -= 1) {
        lengths[a]![b] = order[a] === reference[b] ? 1 + (lengths[a + 1]?.[b + 1] ?? 0)
            : Math.max(lengths[a + 1]?.[b] ?? 0, lengths[a]?.[b + 1] ?? 0);
    }
    const settled = new Set<string>();
    for (let a = 0, b = 0; a < order.length && b < reference.length;) {
        if (order[a] === reference[b]) { settled.add(order[a]!); a += 1; b += 1; }
        else if ((lengths[a + 1]?.[b] ?? 0) >= (lengths[a]?.[b + 1] ?? 0)) a += 1;
        else b += 1;
    }
    return settled;
}
/**
 * What an edited layout changed, read from the same two values `isWidgetAreaPresetEdited` compares:
 * a rename, then each item in the layout's order (added, moved, or with other options), then what was
 * removed. An item that only shifted because a neighbour moved past it is not reported as moved.
 */
function describeWidgetAreaPresetChanges(layout: WidgetAreaLayoutV1, preset: z.output<typeof WidgetAreaPresetV1Schema> | undefined): WidgetAreaPresetChangeV1[] {
    if (!preset || !isWidgetAreaPresetEdited(layout, preset)) return [];
    const now = presetEntries(layout.items);
    const before = presetEntries(preset.items);
    const beforeById = new Map(before.map(entry => [entry.id, entry]));
    const nowIds = new Set(now.map(entry => entry.id));
    const kept = now.filter(entry => beforeById.has(entry.id)).map(entry => entry.id);
    const keptBefore = before.filter(entry => nowIds.has(entry.id)).map(entry => entry.id);
    const settled = settledIds(kept, keptBefore);
    const changes: WidgetAreaPresetChangeV1[] = layout.name !== preset.name ? [{ kind: 'renamed' }] : [];
    for (const entry of now) {
        const previous = beforeById.get(entry.id);
        if (!previous) { changes.push({ kind: 'added', item: entry.item }); continue; }
        if (previous.parentId !== entry.parentId || !settled.has(entry.id)) {
            changes.push({ kind: 'moved', item: entry.item, direction: kept.indexOf(entry.id) <= keptBefore.indexOf(entry.id) ? 'up' : 'down' });
        } else if (!sameStrictJsonValue(previous.own, entry.own)) changes.push({ kind: 'changed', item: entry.item });
    }
    for (const entry of before) if (!nowIds.has(entry.id)) changes.push({ kind: 'removed', item: entry.item });
    return changes;
}
/** Singleton identity contains only captured owner facts, never page context or checkout. */
export function buildWidgetSurfaceArtifactIdV1(raw: WidgetSurfaceRefV1): string {
    const surface = storedSurface(raw);
    const bytes = sha1(new TextEncoder().encode(JSON.stringify([WIDGET_SURFACE_ARTIFACT_KIND_V1, surface]))).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function presentation(layout: WidgetAreaLayoutV1, id: string) {
    const entry = findWidgetLayoutItemV1(layout.items, id);
    if (!entry) throw new WidgetAreaMutationErrorV1('widget_instance_not_found');
    const parent = findWidgetLayoutParentV1(layout.items, id);
    const area = layout.surface.owner.kind === 'project' ? parent?.area ?? entry.area ?? 'main' : undefined;
    const nativeIndex = parent ? parent.children.findIndex(child => child.instance.id === id)
        : layout.items.filter(item => area === undefined || (item.area ?? 'main') === area).findIndex(item => getWidgetLayoutItemIdV1(item) === id);
    return { nativeIndex, frameStyle: entry.frameStyle ?? null, ...(area ? { area } : {}), ...(entry.kind === 'widget' && entry.size ? { size: entry.size } : {}), groupId: parent?.id ?? null };
}
export function applyWidgetAreaLayoutIntentV1(layout: WidgetAreaLayoutV1, raw: WidgetAreaLayoutIntentV1): WidgetAreaLayoutV1 {
    const intent = WidgetAreaLayoutIntentV1Schema.parse(raw);
    if ('area' in intent && intent.area && layout.surface.owner.kind !== 'project') throw new WidgetAreaMutationErrorV1('widget_placement_unsupported');
    if (intent.kind === 'size' && !normalizeWidgetSizeForSurfaceV1(layout.surface.owner.kind, intent.size)) throw new WidgetAreaMutationErrorV1('widget_size_unsupported');
    if ('instanceId' in intent && (intent.kind === 'remove' || intent.kind === 'move')) {
        const current = findWidgetLayoutItemV1(layout.items, intent.instanceId);
        if (!current) throw new WidgetAreaMutationErrorV1('widget_instance_not_found');
        if ('expectedInstance' in intent && intent.expectedInstance && (current.kind !== 'widget' || !sameStrictJsonValue(intent.expectedInstance, current.instance))) throw new WidgetAreaMutationErrorV1('widget_instance_changed');
        if ('expectedPresentation' in intent && intent.expectedPresentation && !sameStrictJsonValue(intent.expectedPresentation, presentation(layout, intent.instanceId))) throw new WidgetAreaMutationErrorV1('widget_placement_changed');
    }
    const draft = { ...intent };
    if ('expectedInstance' in draft) delete draft.expectedInstance;
    if ('expectedPresentation' in draft) delete draft.expectedPresentation;
    let operation = WidgetLayoutItemIntentV1Schema.parse(draft);
    if (operation.kind === 'add') {
        const size = normalizeWidgetSizeForSurfaceV1(layout.surface.owner.kind, operation.size);
        operation = { ...operation, ...(size ? { size } : {}), ...(layout.surface.owner.kind === 'project' ? { area: operation.area ?? 'main' } : {}) };
    }
    if ((operation.kind === 'add' || operation.kind === 'move') && layout.surface.owner.kind === 'project' && !operation.groupId) {
        const area = operation.area ?? (operation.kind === 'move'
            ? findWidgetLayoutParentV1(layout.items, operation.instanceId)?.area ?? findWidgetLayoutItemV1(layout.items, operation.instanceId)?.area
            : undefined) ?? 'main';
        const candidates = layout.items.filter(item => operation.kind !== 'move' || getWidgetLayoutItemIdV1(item) !== operation.instanceId);
        const positions = candidates.flatMap((item, at) => (item.area ?? 'main') === area ? [at] : []);
        const ordinal = Math.min(operation.toIndex ?? positions.length, positions.length);
        const toIndex = positions[ordinal] ?? (positions.length ? positions[positions.length - 1]! + 1 : candidates.length);
        operation = { ...operation, area, toIndex };
    }
    const items = applyWidgetLayoutItemIntentV1(layout.items, operation);
    return items === layout.items ? layout : { ...layout, items };
}
export type WidgetSurfaceArtifactPortV1 = Readonly<{
    surface: WidgetSurfaceRefV1;
    read(signal?: AbortSignal): Promise<WidgetAreaLayoutV1>;
    readState(signal?: AbortSignal): Promise<WidgetAreaReadV1>;
    apply(intent: WidgetAreaLayoutIntentV1, signal?: AbortSignal): Promise<WidgetAreaLayoutV1>;
    resetPreset(expectedRevision?: WorkBoardArtifactRevisionV1 | null, signal?: AbortSignal): Promise<WidgetAreaPresetResultV1>;
    undoReset(capture: WidgetAreaPresetUndoV1, signal?: AbortSignal): Promise<WidgetAreaPresetResultV1>;
}>;
export type WidgetAreaReadV1 =
    | Readonly<{ kind: 'missing'; surface: WidgetSurfaceRefV1; layout: WidgetAreaLayoutV1; preset?: WidgetAreaPresetStateV1 }>
    | Readonly<{ kind: 'present'; layout: WidgetAreaLayoutV1; access: ArtifactCallerAccessV1; revision: WorkBoardArtifactRevisionV1; isShared: boolean; preset?: WidgetAreaPresetStateV1 }>;
const WidgetSurfaceArtifactHeaderV1Schema = lazyZodSchema(() => z.object({
    kind: z.literal(WIDGET_SURFACE_ARTIFACT_KIND_V1), v: z.literal(1), title: z.string().trim().min(1),
    surface: WidgetAreaSurfaceRefV1Schema.optional(), sortKey: z.string().min(1).optional(),
}).strict());
const WidgetSurfaceArtifactHeaderV1StoredSchema = createStoredReadSchema(WidgetSurfaceArtifactHeaderV1Schema);
/** Header discovery and body opening use the same identity and known-field projections. */
export function buildWidgetSurfaceArtifactHeaderV1(layout: WidgetAreaLayoutV1, sortKey = 'a0'): Readonly<Record<string, unknown>> {
    return { kind: WIDGET_SURFACE_ARTIFACT_KIND_V1, v: 1,
        title: layout.name ?? (layout.surface.owner.kind === 'project' ? 'Overview' : 'Widget area'),
        surface: storedSurface(layout.surface), sortKey };
}
export function readWidgetSurfaceArtifactV1(row: Pick<HomeHubArtifactV1, 'artifactId' | 'header' | 'body'>): WidgetAreaLayoutV1 | null {
    const header = WidgetSurfaceArtifactHeaderV1StoredSchema.safeParse(row.header);
    if (!header.success || typeof row.body !== 'string') return null;
    try {
        const parsed = WidgetAreaLayoutV1StoredSchema.safeParse(JSON.parse(row.body));
        if (!parsed.success || parsed.data.surface.artifactId || buildWidgetSurfaceArtifactIdV1(parsed.data.surface) !== row.artifactId) return null;
        if (!header.data.surface || !sameStrictJsonValue(header.data.surface, parsed.data.surface)
            || header.data.title !== (parsed.data.name ?? (parsed.data.surface.owner.kind === 'project' ? 'Overview' : 'Widget area'))) return null;
        return parsed.data;
    } catch { return null; }
}
/** Account mode, encryption and network admission stay with the existing Artifact transport. */
export function createWidgetSurfaceArtifactPortV1(transport: HomeHubArtifactTransportV1, options: Readonly<{
    surface: WidgetSurfaceRefV1; presets?: readonly WidgetAreaPresetV1[]; isCurrent(): boolean;
}>): WidgetSurfaceArtifactPortV1 {
    const surface = WidgetAreaSurfaceRefV1Schema.parse(options.surface);
    const ownerSurface = storedSurface(surface);
    const preset = resolveWidgetAreaPresetV1(surface, hostLayouts(surface, options.presets));
    const initialSortKey = preset?.sortKey ?? 'a0';
    const artifactId = surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(surface);
    if (artifactId !== buildWidgetSurfaceArtifactIdV1(surface)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
    const check = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!options.isCurrent()) throw new WidgetAreaMutationErrorV1('widget_area_scope_retired'); };
    const fetch = async (signal?: AbortSignal) => {
        check(signal); const row = await transport.read(artifactId, { signal }); check(signal);
        if (row && (row.artifactId !== artifactId || row.ownerAccountId !== surface.accountId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        if (row && !ArtifactCallerAccessV1Schema.safeParse(row.access).success) throw new WidgetAreaMutationErrorV1('artifact_access_forbidden');
        if (surface.artifactId && (!row || !ArtifactCallerAccessV1Schema.safeParse(row.access).success)) throw new WidgetAreaMutationErrorV1(row ? 'artifact_access_forbidden' : 'widget_area_not_found');
        if (!row && 'layoutId' in surface.owner && surface.owner.layoutId && !preset) throw new WidgetAreaMutationErrorV1('widget_area_not_found');
        return row;
    };
    const open = (row: Awaited<ReturnType<typeof fetch>>): WidgetAreaLayoutV1 => {
        if (!row) return missingAreaLayout(ownerSurface, preset);
        const layout = readWidgetSurfaceArtifactV1(row);
        if (!layout || !sameStrictJsonValue(layout.surface, ownerSurface)) throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
        return layout;
    };
    const admitWrite = (row: HomeHubArtifactV1 | null, layout: WidgetAreaLayoutV1) => {
        if (row?.access === 'view') throw new WidgetAreaMutationErrorV1('artifact_access_forbidden');
        if (row && (row.shared === true || row.access !== undefined && row.access !== 'owner')
            && (flattenWidgetLayoutWidgetsV1(layout.items).some(entry => getWidgetSharedInputIssuesV1(entry.instance).length > 0)
                || layout.items.some(item => item.kind === 'group' && getWidgetSharedInputIssuesV1(item).length > 0))) throw new WidgetAreaMutationErrorV1('widget_shared_input_forbidden');
    };
    return { surface, read: async signal => open(await fetch(signal)), async readState(signal) {
        const row = await fetch(signal);
        const layout = open(row);
        const state = preset ? { preset: { id: preset.id, name: preset.name, isEdited: isWidgetAreaPresetEdited(layout, preset),
            changes: describeWidgetAreaPresetChanges(layout, preset) } } : {};
        return row ? { kind: 'present', layout, ...state, access: ArtifactCallerAccessV1Schema.parse(row.access), revision: row.revision,
            isShared: row.shared === true || row.access !== undefined && row.access !== 'owner' }
            : { kind: 'missing', surface, layout, ...state };
    }, async resetPreset(expectedRevision, signal) {
        if (!preset) throw new WidgetAreaMutationErrorV1('widget_area_preset_unavailable');
        for (;;) {
            const row = await fetch(signal);
            if (expectedRevision !== undefined && !sameStrictJsonValue(row?.revision ?? null, expectedRevision)) throw new WidgetAreaMutationErrorV1('version_mismatch');
            if (row?.access === 'view') throw new WidgetAreaMutationErrorV1('artifact_access_forbidden');
            const previousLayout = open(row);
            if (!row || !isWidgetAreaPresetEdited(previousLayout, preset)) return { surface, layout: previousLayout };
            const layout = { ...previousLayout, name: preset.name, items: preset.items };
            admitWrite(row, layout);
            check(signal);
            const result = await transport.update({ artifactId, expectedRevision: row.revision,
                header: buildWidgetSurfaceArtifactHeaderV1(layout, typeof row.header.sortKey === 'string' ? row.header.sortKey : initialSortKey), body: JSON.stringify(layout), signal });
            if (result.ok) return { surface, layout, undo: { surface, previousLayout, expectedRevision: result.revision } };
            throw new WidgetAreaMutationErrorV1(result.errorCode);
        }
    }, async undoReset(raw, signal) {
        const capture = WidgetAreaPresetUndoV1Schema.parse(raw);
        if (!preset) throw new WidgetAreaMutationErrorV1('widget_area_preset_unavailable');
        if (!sameStrictJsonValue(capture.surface, surface) || !sameStrictJsonValue(capture.previousLayout.surface, ownerSurface)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        const row = await fetch(signal);
        if (row?.access === 'view') throw new WidgetAreaMutationErrorV1('artifact_access_forbidden');
        if (!row || !sameStrictJsonValue(row.revision, capture.expectedRevision)) throw new WidgetAreaMutationErrorV1('version_mismatch');
        open(row);
        const layout = capture.previousLayout;
        admitWrite(row, layout);
        check(signal);
        const result = await transport.update({ artifactId, expectedRevision: capture.expectedRevision,
            header: buildWidgetSurfaceArtifactHeaderV1(layout, typeof row.header.sortKey === 'string' ? row.header.sortKey : initialSortKey), body: JSON.stringify(layout), signal });
        if (!result.ok) throw new WidgetAreaMutationErrorV1(result.errorCode);
        return { surface, layout };
    }, async apply(raw, signal) {
        const intent = WidgetAreaLayoutIntentV1Schema.parse(raw);
        for (;;) {
            const row = await fetch(signal);
            const current = open(row);
            if (row?.access === 'view') throw new WidgetAreaMutationErrorV1('artifact_access_forbidden');
            const next = applyWidgetAreaLayoutIntentV1(current, intent);
            admitWrite(row, next);
            if (next === current) return current;
            check(signal);
            const header = buildWidgetSurfaceArtifactHeaderV1(next, typeof row?.header.sortKey === 'string' ? row.header.sortKey : initialSortKey);
            if (!row) {
                try {
                    // Create is idempotent at the Artifact service and may return an
                    // existing singleton. Initialize only; commit every edit through CAS.
                    await transport.create({ artifactId, header: buildWidgetSurfaceArtifactHeaderV1(current, initialSortKey), body: JSON.stringify(current), signal });
                }
                catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'conflict')) throw error; }
                continue;
            }
            const result = await transport.update({ artifactId, expectedRevision: row.revision, header, body: JSON.stringify(next), signal });
            if (result.ok) return next; // Truthful durable acknowledgement even if the mount retired while awaiting it.
            if (result.errorCode !== 'version_mismatch') throw new WidgetAreaMutationErrorV1(result.errorCode);
            check(signal);
        }
    } };
}
export const WidgetAreaLayoutSummaryV1Schema = lazyZodSchema(() => z.object({
    artifactId: z.string().min(1), surface: WidgetAreaSurfaceRefV1Schema, name: z.string().trim().min(1),
    sortKey: z.string().min(1), isDefault: z.boolean(), isPreset: z.boolean(), isEdited: z.boolean(), revision: ArtifactRevisionV1Schema.nullable(),
}).strict());
export type WidgetAreaLayoutSummaryV1 = z.infer<typeof WidgetAreaLayoutSummaryV1Schema>;
export type WidgetAreaLayoutArtifactTransportV1 = HomeHubArtifactTransportV1 & Pick<WorkBoardArtifactTransportV1, 'list' | 'delete'>;
type LayoutMutationV1 = Readonly<{ surface: WidgetSurfaceRefV1; expectedRevision: WorkBoardArtifactRevisionV1 | null }>;
function summary(surface: WidgetSurfaceRefV1, name: string, sortKey: string, revision: WorkBoardArtifactRevisionV1 | null, isPreset = false, isDefault = false, isEdited = false): WidgetAreaLayoutSummaryV1 {
    return { artifactId: buildWidgetSurfaceArtifactIdV1(surface), surface: storedSurface(surface), name, sortKey,
        isDefault, isPreset, isEdited, revision };
}
function layoutSortKeyBetween(before: string | null, after: string | null, artifactId: string) {
    let key = generateKeyBetween(before, after);
    // Concurrent document creates/moves may choose the same gap. Keep a single
    // scalar per document, using its existing identity to break that tie without
    // rewriting siblings. An extension of an upper-bound prefix would cross it.
    while (after?.startsWith(key)) key = generateKeyBetween(before, key);
    return key + bytesToHex(sha1(new TextEncoder().encode(artifactId))) + '1';
}
/** Inventory pages headers; personal presets open through the same owner as Reset to compare content. */
export function createWidgetAreaLayoutArtifactPortV1(transport: WidgetAreaLayoutArtifactTransportV1, options: Readonly<{
    surface: WidgetSurfaceRefV1; presets?: readonly WidgetAreaPresetV1[]; isCurrent(): boolean;
}>) {
    const scope = WidgetAreaSurfaceRefV1Schema.parse(options.surface);
    const baseOwner = { ...scope.owner };
    if ('layoutId' in baseOwner) delete baseOwner.layoutId;
    const defaultSurface: WidgetSurfaceRefV1 = { serverId: scope.serverId, accountId: scope.accountId, owner: baseOwner };
    const presets = hostLayouts(scope, options.presets);
    const namedSurface = (layoutId: string): WidgetSurfaceRefV1 => {
        if (baseOwner.kind !== 'project' && baseOwner.kind !== 'corePage' && baseOwner.kind !== 'pluginArea') throw new WidgetAreaMutationErrorV1('widget_area_layout_owner_required');
        return WidgetAreaSurfaceRefV1Schema.parse({ ...defaultSurface, owner: { ...baseOwner, layoutId } });
    };
    const presetFor = (surface: WidgetSurfaceRefV1) => resolveWidgetAreaPresetV1(surface, presets);
    const summarize = (surface: WidgetSurfaceRefV1, name: string, sortKey: string, revision: WorkBoardArtifactRevisionV1 | null, layout?: WidgetAreaLayoutV1) =>
        summary(surface, name, sortKey, revision, !!presetFor(surface), presets.length > 0 && presetFor(surface)?.id === presets[0]?.id,
            layout ? isWidgetAreaPresetEdited(layout, presetFor(surface)) : false);
    const check = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (!options.isCurrent()) throw new WidgetAreaMutationErrorV1('widget_area_scope_retired'); };
    const sameAreaOwner = (surface: WidgetSurfaceRefV1) => {
        const owner = { ...surface.owner };
        if ('layoutId' in owner) delete owner.layoutId;
        return surface.serverId === scope.serverId && surface.accountId === scope.accountId && sameStrictJsonValue(owner, baseOwner);
    };
    const target = (raw: WidgetSurfaceRefV1) => {
        const surface = WidgetAreaSurfaceRefV1Schema.parse(raw);
        if (!sameAreaOwner(surface)) throw new WidgetAreaMutationErrorV1('widget_area_layout_owner_required');
        return surface;
    };
    const requireOwner = () => { if (scope.artifactId) throw new WidgetAreaMutationErrorV1('widget_area_layout_owner_required'); };
    const fetch = async (surface: WidgetSurfaceRefV1, signal?: AbortSignal, contentEdit = false) => {
        check(signal);
        const row = await transport.read(buildWidgetSurfaceArtifactIdV1(surface), { signal }); check(signal);
        if (surface.artifactId && (surface.artifactId !== buildWidgetSurfaceArtifactIdV1(surface) || !row || !ArtifactCallerAccessV1Schema.safeParse(row.access).success)) throw new WidgetAreaMutationErrorV1('artifact_access_forbidden');
        if (row && (row.ownerAccountId !== scope.accountId || !ArtifactCallerAccessV1Schema.safeParse(row.access).success
            || (contentEdit ? row.access === 'view' : row.access !== 'owner'))) throw new WidgetAreaMutationErrorV1(contentEdit ? 'artifact_access_forbidden' : 'widget_area_layout_owner_required');
        const layout = row ? readWidgetSurfaceArtifactV1(row) : null;
        if (row && (!layout || !sameStrictJsonValue(layout.surface, storedSurface(surface)))) throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
        return row;
    };
    const rowSummary = (row: HomeHubArtifactV1) => {
        const layout = readWidgetSurfaceArtifactV1(row);
        if (!layout) throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
        return summarize(layout.surface, layout.name ?? 'Overview', typeof row.header.sortKey === 'string' ? row.header.sortKey : 'a0', row.revision, layout);
    };
    const list = async (signal?: AbortSignal): Promise<readonly WidgetAreaLayoutSummaryV1[]> => {
        requireOwner();
        const entries = new Map<string, WidgetAreaLayoutSummaryV1>();
        for (const preset of presets) {
            const fallback = summarize(namedSurface(preset.id), preset.name, preset.sortKey, null);
            entries.set(fallback.artifactId, fallback);
        }
        let cursor: string | undefined;
        do {
            check(signal);
            // The existing Artifact page maximum, not a dashboard count limit.
            const page = await transport.list({ limit: 500, ...(cursor ? { cursor } : {}), signal }); check(signal);
            for (const item of page.items) {
                if (item.ownerAccountId !== scope.accountId || item.access !== 'owner') continue;
                const parsed = WidgetSurfaceArtifactHeaderV1StoredSchema.safeParse(item.header);
                if (!parsed.success || !parsed.data.surface || parsed.data.surface.artifactId || !sameAreaOwner(parsed.data.surface)
                    || buildWidgetSurfaceArtifactIdV1(parsed.data.surface) !== item.artifactId) continue;
                const revision = 'bodyVersion' in item && typeof item.bodyVersion === 'number'
                    ? { headerVersion: item.headerVersion, bodyVersion: item.bodyVersion } : null;
                if (presetFor(parsed.data.surface)) {
                    const row = await fetch(parsed.data.surface, signal);
                    // A concurrently removed personal copy returns to the host preset projection.
                    if (row) entries.set(item.artifactId, rowSummary(row));
                } else entries.set(item.artifactId, summarize(parsed.data.surface, parsed.data.title, parsed.data.sortKey ?? 'a0', revision));
            }
            cursor = page.nextCursor;
        } while (cursor);
        return [...entries.values()].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.artifactId.localeCompare(b.artifactId));
    };
    const expectRevision = (row: HomeHubArtifactV1 | null, expectedRevision: WorkBoardArtifactRevisionV1 | null) => {
        if (!sameStrictJsonValue(row?.revision ?? null, expectedRevision)) throw new WidgetAreaMutationErrorV1('version_mismatch');
    };
    const save = async (surface: WidgetSurfaceRefV1, row: HomeHubArtifactV1 | null, layout: WidgetAreaLayoutV1, sortKey: string, signal?: AbortSignal) => {
        check(signal);
        const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
        const header = buildWidgetSurfaceArtifactHeaderV1(layout, sortKey);
        if (!row) {
            const acknowledged = await transport.create({ artifactId, header, body: JSON.stringify(layout), signal });
            if (acknowledged.ownerAccountId !== scope.accountId || !sameStrictJsonValue(readWidgetSurfaceArtifactV1(acknowledged), layout)
                || acknowledged.header.sortKey !== sortKey) throw new WidgetAreaMutationErrorV1('version_mismatch');
            return rowSummary(acknowledged);
        }
        const result = await transport.update({ artifactId, expectedRevision: row.revision, header, body: JSON.stringify(layout), signal });
        if (!result.ok) throw new WidgetAreaMutationErrorV1(result.errorCode);
        return summarize(surface, layout.name ?? 'Overview', sortKey, result.revision, layout);
    };
    return {
        list,
        async create(input: Readonly<{ layoutId: string; name: string; fromSurface?: WidgetSurfaceRefV1 }>, signal?: AbortSignal) {
            requireOwner();
            const surface = target(namedSurface(z.string().trim().min(1).parse(input.layoutId)));
            if (presetFor(surface)) throw new WidgetAreaMutationErrorV1('widget_area_layout_already_exists');
            const name = z.string().trim().min(1).parse(input.name);
            const row = await fetch(surface, signal);
            if (row) throw new WidgetAreaMutationErrorV1('widget_area_layout_already_exists');
            const entries = await list(signal);
            const sortKey = layoutSortKeyBetween(entries.at(-1)?.sortKey ?? null, null, buildWidgetSurfaceArtifactIdV1(surface));
            let items: WidgetAreaLayoutV1['items'] = [];
            if (input.fromSurface) {
                const source = target(input.fromSurface);
                items = (await createWidgetSurfaceArtifactPortV1(transport, { surface: source, presets: options.presets, isCurrent: options.isCurrent }).read(signal)).items;
            }
            return save(surface, null, { v: 1, surface, name, items }, sortKey, signal);
        },
        async rename(input: LayoutMutationV1 & Readonly<{ name: string }>, signal?: AbortSignal) {
            const surface = target(input.surface);
            const row = await fetch(surface, signal, true); expectRevision(row, input.expectedRevision);
            if (!row && !presetFor(surface)) throw new WidgetAreaMutationErrorV1('widget_area_not_found');
            const layout = row ? readWidgetSurfaceArtifactV1(row)! : missingAreaLayout(surface, presetFor(surface));
            return save(surface, row, { ...layout, name: z.string().trim().min(1).parse(input.name) }, typeof row?.header.sortKey === 'string' ? row.header.sortKey : presetFor(surface)?.sortKey ?? 'a0', signal);
        },
        async delete(input: LayoutMutationV1, signal?: AbortSignal) {
            requireOwner();
            const surface = target(input.surface);
            if (presetFor(surface)) throw new WidgetAreaMutationErrorV1('widget_area_layout_default_protected');
            const row = await fetch(surface, signal); expectRevision(row, input.expectedRevision);
            if (!row) throw new WidgetAreaMutationErrorV1('widget_area_not_found');
            check(signal);
            const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
            const result = await transport.delete(artifactId, { expectedRevision: row.revision, signal });
            if (!result.ok) throw new WidgetAreaMutationErrorV1(result.errorCode);
            return { artifactId, surface };
        },
        async reorder(input: LayoutMutationV1 & Readonly<{ position: AnchoredListPositionV1 }>, signal?: AbortSignal) {
            requireOwner();
            const surface = target(input.surface);
            const position = AnchoredListPositionV1Schema.parse(input.position);
            const row = await fetch(surface, signal); expectRevision(row, input.expectedRevision);
            if (!row && !presetFor(surface)) throw new WidgetAreaMutationErrorV1('widget_area_not_found');
            const entries = await list(signal);
            const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
            const ids = entries.map(entry => entry.artifactId);
            const moved = resolveAnchoredListMoveV1(ids, artifactId, position);
            if (!moved) throw new WidgetAreaMutationErrorV1('widget_area_layout_anchor_changed');
            const layout = row ? readWidgetSurfaceArtifactV1(row)! : missingAreaLayout(surface, presetFor(surface));
            if (sameStrictJsonValue(ids, moved) && row) return rowSummary(row);
            const at = moved.indexOf(artifactId);
            const before = entries.find(entry => entry.artifactId === moved[at - 1]);
            const after = entries.find(entry => entry.artifactId === moved[at + 1]);
            return save(surface, row, layout, layoutSortKeyBetween(before?.sortKey ?? null, after?.sortKey ?? null, artifactId), signal);
        },
    };
}
/** Both area arms adapt to this writer. No consumer owns layout reduction or CAS. */
export function createWidgetAreaActionPortV1(resolve: (surface: WidgetSurfaceRefV1) => WidgetSurfaceArtifactPortV1 | Promise<WidgetSurfaceArtifactPortV1>): WidgetActionSurfacePortV1 {
    const failure = (error: unknown) => {
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
            return { ok: false as const, errorCode: error.code, error: error.code };
        }
        throw error;
    };
    const portFor = async (surface: WidgetSurfaceRefV1) => { const port = await resolve(surface); if (!sameStrictJsonValue(port.surface, surface)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch'); return port; };
    const capture = (layout: WidgetAreaLayoutV1, id: string): WidgetMoveCaptureV1 => {
        const expectedPresentation = presentation(layout, id);
        const entry = findWidgetLayoutItemV1(layout.items, id);
        if (!entry || entry.kind !== 'widget') throw new WidgetAreaMutationErrorV1('unsupported_widget_transfer');
        return { expectedInstance: entry.instance, expectedPresentation };
    };
    return {
        async read(surface, _context, signal) { try {
            const state = await (await portFor(surface)).readState(signal);
            return { surface, state: state.kind, canEdit: state.kind === 'missing' || state.access !== 'view',
                revision: state.kind === 'present' ? state.revision : null,
                isShared: state.kind === 'present' && state.isShared,
                items: state.layout.items,
                instances: flattenWidgetLayoutWidgetsV1(state.layout.items).map(({ kind: _kind, ...entry }) => {
                    const parent = findWidgetLayoutParentV1(state.layout.items, entry.instance.id);
                    return surface.owner.kind === 'project' && parent ? { ...entry, area: parent.area ?? 'main' as const } : entry;
                }),
                ...(state.preset ? { preset: state.preset } : {}),
                ...(surface.owner.kind === 'project' ? { dashboard: { name: state.layout.name ?? 'Overview',
                    ownerAccountId: surface.accountId, access: state.kind === 'present' ? state.access : 'owner' as const } } : {}) };
        } catch (error) { return failure(error); } },
        async captureMove(surface, id, _context, signal) { try { return capture(await (await portFor(surface)).read(signal), id); } catch (error) { return failure(error); } },
        async apply(surface, mutation: WidgetSurfaceMutationV1, _context, signal) {
            try {
                if (mutation.kind === 'add' && (mutation.placement || mutation.position?.tabId) || mutation.kind === 'move' && 'tabId' in mutation && mutation.tabId) throw new WidgetAreaMutationErrorV1('widget_placement_unsupported');
                if (mutation.kind === 'size' && (!WidgetGridSizeV1Schema.safeParse(mutation.size).success || !normalizeWidgetSizeForSurfaceV1(surface.owner.kind, mutation.size))) throw new WidgetAreaMutationErrorV1('widget_size_unsupported');
                let intent: WidgetAreaLayoutIntentV1;
                if (mutation.kind === 'add') {
                    const size = normalizeWidgetSizeForSurfaceV1(surface.owner.kind, mutation.presentation?.size);
                    intent = { kind: 'add', instance: mutation.instance,
                    ...(mutation.groupId ?? mutation.position?.groupId ? { groupId: mutation.groupId ?? mutation.position?.groupId } : {}),
                    ...(mutation.area ?? mutation.position?.area ? { area: mutation.area ?? mutation.position?.area } : {}),
                    ...(mutation.position || mutation.toIndex !== undefined ? { toIndex: mutation.position?.index ?? mutation.toIndex } : {}),
                    ...(size ? { size } : {}),
                    ...(mutation.presentation?.frameStyle ? { frameStyle: mutation.presentation.frameStyle } : {}) };
                }
                else if (mutation.kind === 'move') intent = { kind: 'move', instanceId: mutation.instanceId, toIndex: 'nativeIndex' in mutation ? mutation.nativeIndex : mutation.toIndex,
                    ...(mutation.area ? { area: mutation.area } : {}), ...('groupId' in mutation && mutation.groupId !== undefined ? { groupId: mutation.groupId } : {}), ...(mutation.expectedInstance ? { expectedInstance: mutation.expectedInstance } : {}),
                    ...(mutation.expectedPresentation ? { expectedPresentation: mutation.expectedPresentation } : {}) };
                else intent = WidgetAreaLayoutIntentV1Schema.parse(mutation);
                const layout = await (await portFor(surface)).apply(intent, signal);
                const id = intent.kind === 'add' ? intent.instance.id : intent.kind === 'group_create' ? intent.groupId : intent.kind === 'group_add' ? intent.group.id : intent.instanceId;
                const entry = findWidgetLayoutItemV1(layout.items, id);
                return { ok: true, result: { ref: { surface, instanceId: id }, instance: entry?.kind === 'widget' ? entry.instance : null, item: entry ?? null, ...(entry?.area ? { area: entry.area } : {}),
                    ...(mutation.kind === 'add' && mutation.captureForMove ? { moveCapture: capture(layout, id) } : {}) } };
            } catch (error) { return failure(error); }
        },
    };
}
