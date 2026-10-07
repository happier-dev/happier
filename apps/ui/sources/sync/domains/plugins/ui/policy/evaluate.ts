import type {
    PluginUiChannelV1,
    PluginUiPlatformV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    evaluatePluginPolicyExpressionV2,
    type PluginPolicyExpressionV2,
    type PluginPolicyFactValueV2,
    type PluginPolicyFactsV2,
} from '@happier-dev/protocol/plugins/contributions/public-types';

/** Adapt host facts to Protocol's canonical contribution availability evaluator. */

export type PluginUiPolicyProfileModeV1 = 'session' | 'ephemeral' | 'user';

/**
 * The host evaluation context. Every signal a declared predicate / gate can
 * reference is resolved through this context (never inferred from the entry).
 */
export type PluginUiPolicyEvaluationContext = Readonly<{
    /** Current render platform supplies the canonical `host.platform` fact. */
    platform?: PluginUiPlatformV1 | null;
    /** Host delivery metadata preserved by context composition. */
    channel?: PluginUiChannelV1 | null;
    /** Active browser/profile storage metadata preserved by context composition. */
    profileMode?: PluginUiPolicyProfileModeV1 | null;
    /**
     * Supplies canonical `host.feature` facts. Fail-closed when omitted.
     */
    isFeatureEnabled?: (featureId: string) => boolean;
    /**
     * Host permission resolver preserved by context composition.
     */
    isPermissionGranted?: (permissionId: string) => boolean;
    /**
     * Supplies canonical `session.capability` facts. Fail-closed when omitted.
     */
    isCapabilityEnabled?: (capabilityId: string) => boolean;
    /**
     * Host-owned data supplying canonical plugin, Session, project, machine
     * and browser facts.
     */
    data?: unknown;
}>;

export type PluginUiPolicyDecision = Readonly<{
    visible: boolean;
    enabled: boolean;
    diagnostics: readonly string[];
}>;

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

/**
 * Resolve a JSON-pointer-ish path (`/a/b/c` or `a.b.c`) against the context data.
 * Returns `undefined` when any segment is missing.
 */
function readPath(data: unknown, path: string | undefined): unknown {
    if (!path) {
        return data;
    }
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    const segments = normalized.split(/[./]/);
    let cursor: unknown = data;
    for (const segment of segments) {
        if (segment.length === 0) {
            continue;
        }
        const record = asRecord(cursor);
        if (!record || !(segment in record)) {
            return undefined;
        }
        cursor = record[segment];
    }
    return cursor;
}

function collectPolicyFactNames(expression: unknown, names: Set<string>): void {
    const record = asRecord(expression);
    if (!record) return;
    if (Array.isArray(record.all)) record.all.forEach((child) => collectPolicyFactNames(child, names));
    if (Array.isArray(record.any)) record.any.forEach((child) => collectPolicyFactNames(child, names));
    if (record.not !== undefined) collectPolicyFactNames(record.not, names);
    if (typeof record.fact === 'string') names.add(record.fact);
}

function toPolicyFactValue(value: unknown): PluginPolicyFactValueV2 {
    if (typeof value === 'boolean' || typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
    return undefined;
}

/** Adapt realm-specific resolvers to Protocol's pure fact evaluator. */
function resolveContributionPolicyFacts(
    expression: unknown,
    ctx: PluginUiPolicyEvaluationContext,
): PluginPolicyFactsV2 {
    const names = new Set<string>();
    collectPolicyFactNames(expression, names);
    const facts: Record<string, PluginPolicyFactValueV2> = {};
    for (const fact of names) {
        if (fact === 'host.platform') {
            facts[fact] = ctx.platform ?? undefined;
            continue;
        }
        if (fact === 'host.feature') {
            // Feature ids are expression values, not fact names. Populate the
            // array from the leaves so Protocol can own `enabled` semantics.
            const featureIds: string[] = [];
            const visit = (value: unknown): void => {
                const record = asRecord(value);
                if (!record) return;
                if (Array.isArray(record.all)) record.all.forEach(visit);
                if (Array.isArray(record.any)) record.any.forEach(visit);
                if (record.not !== undefined) visit(record.not);
                if (record.fact === fact && typeof record.value === 'string' && ctx.isFeatureEnabled?.(record.value)) {
                    featureIds.push(record.value);
                }
            };
            visit(expression);
            facts[fact] = ctx.isFeatureEnabled ? featureIds : undefined;
            continue;
        }
        if (fact === 'session.capability') {
            const capabilityIds: string[] = [];
            const visit = (value: unknown): void => {
                const record = asRecord(value);
                if (!record) return;
                if (Array.isArray(record.all)) record.all.forEach(visit);
                if (Array.isArray(record.any)) record.any.forEach(visit);
                if (record.not !== undefined) visit(record.not);
                if (record.fact === fact && typeof record.value === 'string' && ctx.isCapabilityEnabled?.(record.value)) {
                    capabilityIds.push(record.value);
                }
            };
            visit(expression);
            facts[fact] = ctx.isCapabilityEnabled ? capabilityIds : undefined;
            continue;
        }
        facts[fact] = toPolicyFactValue(fact === 'host.platform' ? ctx.platform : readPath(ctx.data, fact));
    }
    return facts;
}

function evaluateContributionAvailability(
    availability: unknown,
    ctx: PluginUiPolicyEvaluationContext,
    diagnostics: string[],
): Readonly<{ visible: boolean; enabled: boolean }> {
    const record = asRecord(availability);
    if (!record) {
        return { visible: true, enabled: true };
    }
    if (record.when !== undefined) {
        const result = evaluatePluginPolicyExpressionV2(
            record.when as PluginPolicyExpressionV2,
            resolveContributionPolicyFacts(record.when, ctx),
        );
        if (result !== true) {
            diagnostics.push(result === null
                ? 'availability_fact_unavailable'
                : 'availability_not_applicable');
            return { visible: false, enabled: false };
        }
    }
    if (record.disabledWhen !== undefined) {
        const result = evaluatePluginPolicyExpressionV2(
            record.disabledWhen as PluginPolicyExpressionV2,
            resolveContributionPolicyFacts(record.disabledWhen, ctx),
        );
        if (result === null) {
            diagnostics.push('availability_disabled_fact_unavailable');
            return { visible: true, enabled: false };
        }
        if (result) {
            diagnostics.push('availability_disabled');
            return { visible: true, enabled: false };
        }
    }
    return { visible: true, enabled: true };
}

/**
 * Evaluate the declared policy of a projection entry against the host context.
 * Protocol owns the expression grammar; this adapter resolves host facts and
 * maps unknown availability to hidden or disabled presentation.
 */
export function evaluatePluginUiPolicy(
    entry: UnknownRecord | null | undefined,
    ctx: PluginUiPolicyEvaluationContext,
): PluginUiPolicyDecision {
    if (!entry) {
        return { visible: false, enabled: false, diagnostics: ['entry_missing'] };
    }

    const diagnostics: string[] = [];

    const availability = evaluateContributionAvailability(entry.availability, ctx, diagnostics);
    if (!availability.visible) {
        return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
    }

    return { visible: true, enabled: availability.enabled, diagnostics: Object.freeze(diagnostics) };
}

/**
 * Convenience: a declared entry is renderable when its evaluated policy is
 * visible. Callers that distinguish disabled-but-visible states should consume
 * the full decision via `evaluatePluginUiPolicy`.
 */
export function isPluginUiPolicyVisible(
    entry: UnknownRecord | null | undefined,
    ctx: PluginUiPolicyEvaluationContext,
): boolean {
    return evaluatePluginUiPolicy(entry, ctx).visible;
}
