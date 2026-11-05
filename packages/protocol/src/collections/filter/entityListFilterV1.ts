import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import type { EntityFilterEvaluatorV1, EntityFilterMatchV1, EntityFilterRegistryV1 } from './fieldRegistryV1.js';
import type { SessionListFilterV1 } from '../../sessions/listFilter/sessionListFilterV1.js';
import type { WorkflowListFilterV1 } from '../../workflows/listing/workflowListFilterV1.js';
import type { DiscussionListFilterV1 } from '../../discussions/listing/discussionListFilterV1.js';

export type CollectionFilterMapV1 = Readonly<{
    sessionWork: SessionListFilterV1;
    workflow: WorkflowListFilterV1;
    discussion: DiscussionListFilterV1;
}>;
export type EntityListFilterV1<E extends keyof CollectionFilterMapV1> = CollectionFilterMapV1[E];

export type SetSelectionV1<T> = Readonly<{ include: readonly T[]; exclude: readonly T[] }>;
export const StringSetSelectionV1Schema: z.ZodMiniType<SetSelectionV1<string>> = lazyZodSchema(() => z.strictObject({
    include: z.array(z.string()), exclude: z.array(z.string()),
}));
export type UpdatedSelectionV1 =
    | Readonly<{ op: 'before' | 'after'; atMs: number }>
    | Readonly<{ op: 'between'; fromMs: number; toMs: number }>;
export type ExtensionSelectionV1 =
    | Readonly<{ kind: 'set'; include: readonly string[]; exclude: readonly string[] }>
    | Readonly<{ kind: 'boolean'; value: boolean }>
    | Readonly<{ kind: 'time'; selection: UpdatedSelectionV1 }>;
export type EntityFilterFactValueV1 = string | readonly string[] | boolean | number | null;

const TimeSchema = lazyZodSchema(() => z.number().check(z.int()));
export const UpdatedSelectionV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ op: z.literal('before'), atMs: TimeSchema }),
    z.strictObject({ op: z.literal('after'), atMs: TimeSchema }),
    z.strictObject({ op: z.literal('between'), fromMs: TimeSchema, toMs: TimeSchema })
        .check(z.refine(value => value.fromMs <= value.toMs)),
]));
export const ExtensionSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('set'), include: z.array(z.string()), exclude: z.array(z.string()) }),
    z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('time'), selection: UpdatedSelectionV1Schema }),
]));

export function matchEntityFilterKnownV1(value: boolean | undefined): EntityFilterMatchV1 {
    return value === undefined ? 'unavailable' : value ? 'match' : 'miss';
}

export function combineEntityFilterMatchesV1(results: Iterable<EntityFilterMatchV1>): EntityFilterMatchV1 {
    let unavailable = false;
    for (const result of results) {
        if (result === 'miss') return 'miss';
        if (result === 'unavailable') unavailable = true;
    }
    return unavailable ? 'unavailable' : 'match';
}

/** Empty positive selection is unrestricted; unknown exclusion facts never satisfy a negative condition. */
export function matchEntityFilterSetV1<T>(
    selection: SetSelectionV1<T>,
    matches: (value: T) => EntityFilterMatchV1,
): EntityFilterMatchV1 {
    const any = (values: readonly T[]): EntityFilterMatchV1 => {
        let unknown = false;
        for (const value of values) {
            const result = matches(value);
            if (result === 'match') return 'match';
            unknown ||= result === 'unavailable';
        }
        return unknown ? 'unavailable' : 'miss';
    };
    const included = selection.include.length ? any(selection.include) : 'match';
    if (included === 'miss') return 'miss';
    const excluded = selection.exclude.length ? any(selection.exclude) : 'miss';
    return combineEntityFilterMatchesV1([included, excluded === 'match' ? 'miss' : excluded === 'miss' ? 'match' : 'unavailable']);
}

export function matchEntityFilterTimeV1(selection: UpdatedSelectionV1, value: number | undefined): EntityFilterMatchV1 {
    if (value === undefined) return 'unavailable';
    if (selection.op === 'between') return matchEntityFilterKnownV1(value >= selection.fromMs && value <= selection.toMs);
    return matchEntityFilterKnownV1(selection.op === 'before' ? value < selection.atMs : value > selection.atMs);
}

export function matchEntityFilterExtensionV1(selection: ExtensionSelectionV1, value: EntityFilterFactValueV1 | undefined): EntityFilterMatchV1 {
    if (selection.kind === 'set') {
        if (value !== undefined && value !== null && typeof value !== 'string' && !Array.isArray(value)) return 'unavailable';
        return matchEntityFilterSetV1(selection, selected => value === undefined ? 'unavailable'
            : matchEntityFilterKnownV1(value === selected || Array.isArray(value) && value.includes(selected)));
    }
    if (selection.kind === 'boolean') return typeof value === 'boolean' ? matchEntityFilterKnownV1(value === selection.value) : 'unavailable';
    return matchEntityFilterTimeV1(selection.selection, typeof value === 'number' ? value : undefined);
}

/** Compile only on filter edits; row evaluation never parses selections, fetches facts or calls a plugin. */
export function compileEntityListFilterV1<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, evaluator: EntityFilterEvaluatorV1 = 'list',
): (facts: Facts, onUnavailable?: (fieldIds: readonly string[]) => void) => EntityFilterMatchV1 {
    const active = registry.flatMap(field => {
        const match = field.compile(filter, evaluator);
        return match ? [{ id: field.id, match }] : [];
    });
    return (facts, onUnavailable) => {
        let unavailable = false;
        const unavailableFields: string[] | undefined = onUnavailable ? [] : undefined;
        for (const { id, match } of active) {
            const result = match(facts);
            if (result === 'miss') return 'miss';
            unavailable ||= result === 'unavailable';
            if (result === 'unavailable') unavailableFields?.push(id);
        }
        // Diagnose only a genuinely unknown result; a proven miss remains a miss even if
        // another clause lacked evidence. Facts are evaluated once by this same predicate.
        if (unavailableFields?.length) onUnavailable?.(unavailableFields);
        return unavailable ? 'unavailable' : 'match';
    };
}

export type EntityListFilterResultV1 = Readonly<{
    matchedCount: number;
    coverage: 'complete' | 'partial' | 'unavailable';
    attentionSupplementCount?: number;
}>;

/** Persistence-only: future narrowing is opaque data, never a successful match or writable condition. */
export function createEntityListFilterStoredReadSchemaV1<T extends z.ZodMiniObject>(schema: T): z.ZodMiniType<z.output<T>, unknown> {
    const fields = Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key, createStoredReadSchema(value)]));
    const read = z.looseObject({ ...fields, extensions: z.optional(z.record(z.string(), z.unknown())) });
    // Containing stored owners may project an already-projected filter again.
    // Dropping opaque narrowing on that second read would widen its membership.
    defineStoredReadProjection(read, () => read);
    // Known fields are derived from the exact canonical schema; opaque fields gain no typed meaning.
    return read as unknown as z.ZodMiniType<z.output<T>, unknown>;
}
