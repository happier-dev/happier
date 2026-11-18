import {
    AutomationEventFilterV1Schema,
    type AutomationEventFilterClauseV1,
    type AutomationEventFilterV1,
    type AutomationJsonScalarV1,
} from '@happier-dev/protocol/automations/automationEventFilterV1';

/** One transient bounded-control clause; never a persisted Event filter shape. */
export type PluginEventAutomationFilterClauseDraft = Readonly<{
    id: string;
    field: string;
    op: AutomationEventFilterClauseV1['op'];
    /** JSON encoding of one scalar or a scalar array (`in`). */
    valueText: string;
}>;

export type PluginEventAutomationFilterDraftRead = Readonly<{
    filter: AutomationEventFilterV1 | null;
    valid: boolean;
}>;

function isJsonScalar(value: unknown): value is AutomationJsonScalarV1 {
    return value === null
        || typeof value === 'string'
        || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value));
}

function parseJson(value: string): unknown {
    const normalized = value.trim();
    if (!normalized) return undefined;
    try {
        return JSON.parse(normalized) as unknown;
    } catch {
        return undefined;
    }
}

function readClause(draft: PluginEventAutomationFilterClauseDraft): unknown | null {
    const field = draft.field.trim();
    if (!field) return null;
    const parsed = parseJson(draft.valueText);
    if (draft.op !== 'in') {
        return isJsonScalar(parsed)
            ? { op: draft.op, field, value: parsed }
            : null;
    }
    if (!Array.isArray(parsed) || !parsed.every(isJsonScalar)) return null;
    return { op: 'in', field, values: parsed };
}

/**
 * Builds only the shared AUTO-17 grammar from bounded controls. It validates
 * syntax/bounds through the Protocol schema; payload-leaf and value semantics
 * remain exclusively with `validateAutomationEventFilterAgainstPayloadSchemaV1`.
 */
export function readPluginEventAutomationFilterDraft(
    drafts: readonly PluginEventAutomationFilterClauseDraft[],
): PluginEventAutomationFilterDraftRead {
    if (drafts.length === 0) return Object.freeze({ valid: true, filter: null });
    const clauses: unknown[] = [];
    for (const draft of drafts) {
        const clause = readClause(draft);
        if (!clause) return Object.freeze({ valid: false, filter: null });
        clauses.push(clause);
    }
    const parsed = AutomationEventFilterV1Schema.safeParse({ v: 1, all: clauses });
    return parsed.success
        ? Object.freeze({ valid: true, filter: parsed.data })
        : Object.freeze({ valid: false, filter: null });
}

/** Converts an already-stored Protocol filter into its bounded editor controls. */
export function readPluginEventAutomationFilterClauses(
    filter: AutomationEventFilterV1 | null,
): readonly PluginEventAutomationFilterClauseDraft[] {
    if (filter === null) return Object.freeze([]);
    const parsed = AutomationEventFilterV1Schema.safeParse(filter);
    if (!parsed.success) return Object.freeze([]);
    return Object.freeze(parsed.data.all.map((clause, index) => Object.freeze({
        id: `persisted-${index}`,
        field: clause.field,
        op: clause.op,
        valueText: JSON.stringify(clause.op === 'in' ? clause.values : clause.value),
    })));
}
