import type {
    EntityFilterEvaluatorV1, EntityFilterFieldKindV1, EntityFilterRegistryV1, EntityFilterConditionOperatorV1,
} from '@happier-dev/plugin-sdk/ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';

export type CollectionConditionValueOption = Readonly<{
    /** Choice identity. For a group, apply `values`, never this presentation key. */
    value: JsonValue;
    /** Absent for a single value; a grouped choice selects this entire vector. */
    values?: readonly JsonValue[];
    label?: string;
    disabled?: boolean;
    /** Frequency in the list's already-held ordinary corpus; absent when local facts are unavailable. */
    count?: number;
}>;
/** A presented value list's demand. Labels, checked state and counts do not change that demand. */
export type CollectionConditionValueCountRequest = Readonly<{
    fieldId: string;
    options: readonly Pick<CollectionConditionValueOption, 'value' | 'values'>[];
}>;
/** Owned by the retained list projection, never fetched or persisted by the editor. */
export type CollectionConditionValueCounts = Readonly<{
    fieldId: string;
    options: readonly Readonly<{ value: JsonValue; count?: number }>[];
}>;
export type CollectionConditionBindings = Readonly<{
    evaluator?: EntityFilterEvaluatorV1;
    fields?: Readonly<Record<string, Readonly<{ label?: string; valueOptions?: readonly CollectionConditionValueOption[] }>>>;
    valueCounts?: CollectionConditionValueCounts;
}>;
export type CollectionConditionField = Readonly<{
    id: string;
    label: string;
    kind: EntityFilterFieldKindV1;
    operators: readonly EntityFilterConditionOperatorV1[];
    valueOptions: readonly CollectionConditionValueOption[];
}>;
export type CollectionCondition = Readonly<{
    fieldId: string;
    operator: EntityFilterConditionOperatorV1;
    values: readonly JsonValue[];
}>;
export type CollectionConditionRow = Readonly<{
    id: string;
    fieldId: string;
    field: CollectionConditionField;
    operator: EntityFilterConditionOperatorV1 | 'unavailable';
    values: readonly JsonValue[];
    available: boolean;
}>;
export type CollectionConditionModel = Readonly<{
    rows: readonly CollectionConditionRow[];
    availableFields: readonly CollectionConditionField[];
}>;
export type CollectionConditionEdit =
    | Readonly<{ type: 'add'; condition: CollectionCondition }>
    | Readonly<{ type: 'change'; rowId: string; condition: CollectionCondition }>
    | Readonly<{ type: 'remove'; rowId: string }>
    | Readonly<{ type: 'clear' }>;

/** Derived only from a field/operator pair; never a persisted row identity. */
const rowId = (fieldId: string, operator: CollectionConditionRow['operator']) => JSON.stringify([fieldId, operator]);

/** Pure editor projection. Labels/options bind semantic ids; they never decide field support. */
const sameJsonValue = (a: JsonValue, b: JsonValue) => JSON.stringify(a) === JSON.stringify(b);
const includesJsonValue = (values: readonly JsonValue[], value: JsonValue) =>
    values.some(candidate => sameJsonValue(candidate, value));

/** The filter values a choice stands for: a grouped choice (a Status group) is its whole vector. */
export function collectionConditionOptionValues(option: CollectionConditionValueOption): readonly JsonValue[] {
    return option.values ?? [option.value];
}

/** A choice is picked when every value it stands for is in the condition. */
export function isCollectionConditionOptionPicked(values: readonly JsonValue[], option: CollectionConditionValueOption): boolean {
    return collectionConditionOptionValues(option).every(value => includesJsonValue(values, value));
}

type CollectionQuickChoiceModel = Readonly<{ rows: readonly CollectionConditionRow[]; availableFields?: readonly CollectionConditionField[] }>;

/** What a choice stands for in its condition: itself, or the registry's whole group (a Work status is several states). */
export function collectionConditionChoiceValues(model: CollectionQuickChoiceModel, fieldId: string, value: JsonValue): readonly JsonValue[] {
    const field = model.availableFields?.find(candidate => candidate.id === fieldId)
        ?? model.rows.find(candidate => candidate.fieldId === fieldId)?.field;
    const option = field?.valueOptions.find(candidate => sameJsonValue(candidate.value, value));
    return option ? collectionConditionOptionValues(option) : [value];
}

/** Whether a choice is on: the field's "is" condition holds everything it stands for. */
export function isCollectionConditionChoiceOn(model: CollectionQuickChoiceModel, fieldId: string, value: JsonValue): boolean {
    const row = model.rows.find(candidate => candidate.fieldId === fieldId && candidate.operator === 'is');
    return row !== undefined && collectionConditionChoiceValues(model, fieldId, value).every(item => includesJsonValue(row.values, item));
}

/**
 * One choice's one-press edit (a filter chip): off when the field's "is" condition holds it, otherwise added to that
 * condition. A set keeps its other values; the last value removes the row.
 */
export function toggleCollectionConditionValue(model: CollectionQuickChoiceModel, fieldId: string, value: JsonValue): CollectionConditionEdit {
    const values = collectionConditionChoiceValues(model, fieldId, value);
    const row = model.rows.find(candidate => candidate.fieldId === fieldId && candidate.operator === 'is');
    if (!row) return { type: 'add', condition: { fieldId, operator: 'is', values } };
    if (!isCollectionConditionChoiceOn(model, fieldId, value)) {
        // A set gathers its choices; any other field holds one, so the press replaces it.
        if (row.field && row.field.kind !== 'set') return { type: 'change', rowId: row.id, condition: { fieldId, operator: 'is', values } };
        const added = values.filter(item => !includesJsonValue(row.values, item));
        return { type: 'change', rowId: row.id, condition: { fieldId, operator: 'is', values: [...row.values, ...added] } };
    }
    const rest = row.values.filter(candidate => !includesJsonValue(values, candidate));
    return rest.length === 0 ? { type: 'remove', rowId: row.id }
        : { type: 'change', rowId: row.id, condition: { fieldId, operator: 'is', values: rest } };
}

/** Isolated option predicates, compiled once per demand through the registry's selection owner. */
export function compileCollectionConditionValueCountOptions<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, request: CollectionConditionValueCountRequest,
    options: Pick<CollectionConditionBindings, 'evaluator'> = {},
): readonly ReturnType<EntityFilterRegistryV1<Filter, Facts>[number]['compile']>[] {
    const field = registry.find(candidate => candidate.id === request.fieldId);
    const evaluator = options.evaluator ?? 'list';
    return request.options.map(option => {
        if (!field?.conditions?.operators.includes('is') || !field.evaluators.includes(evaluator)) return undefined;
        try {
            // An occurrence does not depend on the current opposite-side selection of this field.
            const cleared = field.clearSelection?.(filter) ?? field.conditions.operators.reduce(
                (current, operator) => field.conditions!.remove(current, operator), filter);
            const group = field.conditions.valueGroups?.find(candidate => sameJsonValue(candidate.value, option.value));
            const selected = field.conditions.replace(cleared, { operator: 'is', values: group?.values ?? option.values ?? [option.value] });
            // Registry compile returns no predicate for an unrestricted/default selection.
            return field.compile(selected, evaluator) ?? (() => 'match' as const);
        } catch {
            // An opaque/future value is not an evaluable local choice.
            return undefined;
        }
    });
}

/**
 * Lazy frequencies over a host's held, distinct, pre-local-filter subjects. No loader or subscription;
 * the retained Session projection uses the same compiled options with incremental contributions.
 */
export function collectionConditionValueCountsFromFacts<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter,
    request: CollectionConditionValueCountRequest | null | undefined,
    readHeldFacts: () => Iterable<Facts>, previous?: CollectionConditionValueCounts,
): CollectionConditionValueCounts | undefined {
    if (!request) return undefined;
    const matchers = compileCollectionConditionValueCountOptions(registry, filter, request);
    const totals = matchers.map(() => ({ count: 0, unavailable: false }));
    if (matchers.some(Boolean)) for (const facts of readHeldFacts()) {
        matchers.forEach((match, index) => {
            const verdict = match?.(facts);
            if (verdict === 'match') totals[index]!.count += 1;
            else if (verdict === 'unavailable') totals[index]!.unavailable = true;
        });
    }
    let unchanged = previous?.fieldId === request.fieldId && previous.options.length === request.options.length;
    const valueOptions = request.options.map((option, index) => {
        const count = matchers[index] && !totals[index]!.unavailable ? totals[index]!.count : undefined;
        const old = previous?.fieldId === request.fieldId ? previous.options[index] : undefined;
        if (old && sameJsonValue(old.value, option.value) && old.count === count) return old;
        unchanged = false;
        return { value: option.value, ...(count === undefined ? {} : { count }) };
    });
    return unchanged ? previous : { fieldId: request.fieldId, options: valueOptions };
}

/**
 * A condition's values as words: each fully picked group reads as its one label, then each value left over
 * (a retained single state) reads as its option's label, the caller's format, or itself.
 */
export function collectionConditionValueLabels(
    field: CollectionConditionField,
    values: readonly JsonValue[],
    formatValue?: (field: CollectionConditionField, value: JsonValue) => string,
): string[] {
    const single = (value: JsonValue) => field.valueOptions.find(option => !option.values && sameJsonValue(option.value, value))?.label
        ?? formatValue?.(field, value) ?? (typeof value === 'string' ? value : JSON.stringify(value));
    const covered: JsonValue[] = [];
    const words: string[] = [];
    for (const option of field.valueOptions) {
        if (!option.values || !isCollectionConditionOptionPicked(values, option)) continue;
        covered.push(...option.values);
        words.push(option.label ?? single(option.value));
    }
    for (const value of values) if (!includesJsonValue(covered, value)) words.push(single(value));
    return words;
}

export function conditionModelFromFilter<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, bindings: CollectionConditionBindings = {},
): CollectionConditionModel {
    const rows: CollectionConditionRow[] = [];
    const availableFields: CollectionConditionField[] = [];
    for (const descriptor of registry) {
        const presentation = bindings.fields?.[descriptor.id];
        const groups = descriptor.conditions?.valueGroups ?? [];
        const valueOptions = presentation?.valueOptions ?? (groups.length
            ? groups : descriptor.conditions?.valueOptions.map(value => ({ value })) ?? []);
        const canonicalOptions = groups.length ? valueOptions.map(option => {
            const group = groups.find(candidate => sameJsonValue(candidate.value, option.value));
            // Presentation may label/disable a group, but its selection vector remains registry-owned.
            return group ? { ...option, values: group.values } : option;
        }) : valueOptions;
        const counts = bindings.valueCounts?.fieldId === descriptor.id ? bindings.valueCounts.options : undefined;
        const field: CollectionConditionField = {
            id: descriptor.id, label: presentation?.label ?? descriptor.id, kind: descriptor.kind,
            operators: descriptor.conditions?.operators ?? [],
            valueOptions: counts ? canonicalOptions.map(option => {
                const count = counts.find(candidate => sameJsonValue(candidate.value, option.value))?.count;
                return count === undefined ? option : { ...option, count };
            }) : canonicalOptions,
        };
        const available = Boolean(descriptor.conditions && descriptor.evaluators.includes(bindings.evaluator ?? 'list'));
        if (available) availableFields.push(field);
        if (!descriptor.isActive(filter)) continue;
        // Stored future selections must stay visible. Only the owner can admit their values.
        let conditions: ReturnType<NonNullable<typeof descriptor.conditions>['project']> | undefined = undefined;
        try { conditions = descriptor.conditions?.project(filter); } catch { conditions = undefined; }
        if (!conditions?.length) {
            rows.push({ id: rowId(field.id, 'unavailable'), fieldId: field.id, field,
                operator: 'unavailable', values: [], available: false });
        } else for (const condition of conditions) rows.push({ ...condition,
            id: rowId(field.id, condition.operator), fieldId: field.id, field, available });
    }
    return { rows, availableFields };
}

/** Applies an explicit editor intent through the same typed selection owner. Input is never mutated. */
export function applyCollectionConditionEdit<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, edit: CollectionConditionEdit,
    options: Pick<CollectionConditionBindings, 'evaluator'> = {},
): Filter {
    if (edit.type === 'clear') {
        // Clear is explicit, including opaque narrowing; unrelated edits never remove it.
        return registry.reduce((current, field) => field.clearSelection?.(current) ?? current, filter);
    }
    const model = conditionModelFromFilter(registry, filter, options);
    let next = filter;
    if (edit.type === 'remove' || edit.type === 'change') {
        const row = model.rows.find(candidate => candidate.id === edit.rowId);
        const owner = registry.find(candidate => candidate.id === row?.fieldId);
        if (!row || !owner) throw new TypeError('Condition row is no longer present');
        if (row.operator === 'unavailable') {
            if (!owner.clearSelection) throw new TypeError('Condition cannot be removed');
            next = owner.clearSelection(next);
        } else {
            if (!owner.conditions) throw new TypeError('Condition has no selection owner');
            next = owner.conditions.remove(next, row.operator);
        }
        if (edit.type === 'remove') return next;
    }
    const condition = edit.condition;
    const owner = registry.find(field => field.id === condition.fieldId);
    if (!owner?.conditions || !owner.evaluators.includes(options.evaluator ?? 'list')
        || !owner.conditions.operators.includes(condition.operator)) throw new TypeError('Condition is not supported');
    // A changed row replaces itself: a scalar field's row stays present after its removal (its default value).
    const changed = edit.type === 'change' ? model.rows.find(row => row.id === edit.rowId) : undefined;
    const replacing = changed?.fieldId === condition.fieldId && changed.operator === condition.operator;
    if (!replacing && conditionModelFromFilter(registry, next, options).rows.some(row => row.id === rowId(condition.fieldId, condition.operator))) {
        throw new TypeError('Condition already exists; change its row instead');
    }
    return owner.conditions.replace(next, condition);
}
