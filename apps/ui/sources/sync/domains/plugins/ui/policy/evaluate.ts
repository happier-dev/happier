import type {
    PluginUiChannelV1,
    PluginUiPlatformV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    evaluatePluginPolicyExpressionV2,
    type PluginPolicyExpressionV2,
    type PluginPolicyFactValueV2,
    type PluginPolicyFactsV2,
} from '@happier-dev/protocol';

/**
 * Phase 1.1 — the single canonical plugin-UI policy evaluator.
 *
 * Replaces the `DEFERRED_POLICY_FIELDS` accept-and-hide predicates in
 * `plugins/ui/policy.ts` + `plugins/browser/policy.ts`. Instead of silently
 * hiding any entry that DECLARES `visibility/enabled/featureGate/compatibility`
 * (or `policy.requiredFeatureIds/requiredPermissionIds/profileMode`), this owner
 * EVALUATES the declared predicates against the host evaluation context and
 * renders conditionally.
 *
 * Decision shape:
 *   - `visible`  — whether the surface/entry should mount at all
 *   - `enabled`  — whether it should mount in an interactive (vs. disabled) state
 *   - `diagnostics` — the reasons a gate failed (host-side, never plugin-authored)
 *
 * Fail-closed: a missing/malformed context resolver, an unknown predicate
 * operand, or an undeclared-but-required signal collapses to NOT visible.
 */

export type PluginUiPolicyProfileModeV1 = 'session' | 'ephemeral' | 'user';

/**
 * The host evaluation context. Every signal a declared predicate / gate can
 * reference is resolved through this context (never inferred from the entry).
 */
export type PluginUiPolicyEvaluationContext = Readonly<{
    /** Current render platform. Used by `compatibility.platforms` + `platform.is`. */
    platform?: PluginUiPlatformV1 | null;
    /** Current delivery channel. Used by `compatibility.channels`. */
    channel?: PluginUiChannelV1 | null;
    /** Active browser/profile storage mode. Used by `policy.profileMode`. */
    profileMode?: PluginUiPolicyProfileModeV1 | null;
    /**
     * Resolves whether a feature id is enabled. Used by `featureGate`,
     * `compatibility.featureGate`, `policy.requiredFeatureIds`, and the
     * `feature.enabled` predicate operand. Fail-closed when omitted.
     */
    isFeatureEnabled?: (featureId: string) => boolean;
    /**
     * Resolves whether a durable permission grant is held. Used by
     * `policy.requiredPermissionIds`. Fail-closed when omitted.
     */
    isPermissionGranted?: (permissionId: string) => boolean;
    /**
     * Resolves whether a runtime capability is available. Used by the
     * `capability.enabled` predicate operand. Fail-closed when omitted.
     */
    isCapabilityEnabled?: (capabilityId: string) => boolean;
    /**
     * The data object that path-based predicate operands resolve against
     * (e.g. `{ operand: 'pathTruthy', path: '/enabled' }`). Optional.
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

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
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

function isTruthyValue(value: unknown): boolean {
    if (value === undefined || value === null) {
        return false;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value.trim().length > 0;
    }
    if (typeof value === 'number') {
        return value !== 0 && !Number.isNaN(value);
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    return true;
}

type LeafPredicate = Readonly<{
    operand: string;
    path?: string;
    value?: unknown;
    values?: readonly unknown[];
}>;

function evaluateLeafPredicate(
    leaf: LeafPredicate,
    ctx: PluginUiPolicyEvaluationContext,
): boolean {
    const operand = leaf.operand;
    switch (operand) {
        case 'feature.enabled': {
            const featureId = typeof leaf.value === 'string' ? leaf.value : undefined;
            return Boolean(featureId) && (ctx.isFeatureEnabled?.(featureId!) ?? false);
        }
        case 'capability.enabled': {
            const capabilityId = typeof leaf.value === 'string' ? leaf.value : undefined;
            return Boolean(capabilityId) && (ctx.isCapabilityEnabled?.(capabilityId!) ?? false);
        }
        case 'platform.is': {
            const candidates = leaf.values
                ? readStringArray(leaf.values)
                : typeof leaf.value === 'string'
                    ? [leaf.value]
                    : [];
            return ctx.platform != null && candidates.includes(ctx.platform);
        }
        default: {
            // Data-shaped operands (`session.*`, `resource.*`, `message.*`, …):
            // evaluate against the supplied data context. When a concrete value
            // is declared, require equality / membership; otherwise require the
            // resolved path to be truthy. Fail-closed for an unknown operand with
            // no resolvable data.
            const resolved = readPath(ctx.data, leaf.path ?? operand.replace(/\./g, '/'));
            if (leaf.values) {
                return readStringArray(leaf.values).some((candidate) => candidate === resolved);
            }
            if (leaf.value !== undefined) {
                return resolved === leaf.value;
            }
            return isTruthyValue(resolved);
        }
    }
}

/**
 * A declared plugin-UI predicate. Structural shape of the canonical
 * `PluginUiPredicateV1` (`all`/`any`/`not`/leaf-`operand`); read leniently
 * because the projection model carries predicates as passthrough records.
 */
export type PluginUiPredicateLike = UnknownRecord;

export function evaluatePluginUiPredicate(
    predicate: PluginUiPredicateLike | undefined | null,
    ctx: PluginUiPolicyEvaluationContext,
): boolean {
    if (predicate === undefined || predicate === null) {
        return true;
    }
    const record = asRecord(predicate);
    if (!record) {
        return false;
    }
    if (Array.isArray(record.all)) {
        return (record.all as readonly unknown[]).every((child) =>
            evaluatePluginUiPredicate(child as UnknownRecord, ctx),
        );
    }
    if (Array.isArray(record.any)) {
        return (record.any as readonly unknown[]).some((child) =>
            evaluatePluginUiPredicate(child as UnknownRecord, ctx),
        );
    }
    if (record.not !== undefined) {
        return !evaluatePluginUiPredicate(record.not as UnknownRecord, ctx);
    }
    if (typeof record.operand === 'string') {
        return evaluateLeafPredicate(
            {
                operand: record.operand,
                ...(typeof record.path === 'string' ? { path: record.path } : {}),
                ...('value' in record ? { value: record.value } : {}),
                ...(Array.isArray(record.values) ? { values: record.values } : {}),
            },
            ctx,
        );
    }
    return false;
}

function evaluateCompatibility(
    compatibility: unknown,
    ctx: PluginUiPolicyEvaluationContext,
    diagnostics: string[],
): boolean {
    const record = asRecord(compatibility);
    if (!record) {
        return true;
    }
    const platforms = readStringArray(record.platforms);
    if (platforms.length > 0) {
        if (ctx.platform == null || !platforms.includes(ctx.platform)) {
            diagnostics.push('compatibility_platform_unsupported');
            return false;
        }
    }
    const channels = readStringArray(record.channels);
    if (channels.length > 0) {
        if (ctx.channel == null || !channels.includes(ctx.channel)) {
            diagnostics.push('compatibility_channel_unsupported');
            return false;
        }
    }
    const featureGate = typeof record.featureGate === 'string' ? record.featureGate.trim() : '';
    if (featureGate.length > 0 && !(ctx.isFeatureEnabled?.(featureGate) ?? false)) {
        diagnostics.push('compatibility_feature_disabled');
        return false;
    }
    return true;
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
 * The entry is the canonical projection record (UI surface placement / session
 * surface / header action / browser target or action); declared policy fields
 * are read leniently because the projection model carries them as passthrough.
 */
export function evaluatePluginUiPolicy(
    entry: UnknownRecord | null | undefined,
    ctx: PluginUiPolicyEvaluationContext,
): PluginUiPolicyDecision {
    if (!entry) {
        return { visible: false, enabled: false, diagnostics: ['entry_missing'] };
    }

    const diagnostics: string[] = [];

    // featureGate (string feature id) — fail-closed.
    const featureGate = typeof entry.featureGate === 'string' ? entry.featureGate.trim() : '';
    if (featureGate.length > 0 && !(ctx.isFeatureEnabled?.(featureGate) ?? false)) {
        diagnostics.push('feature_gate_disabled');
        return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
    }

    // compatibility (platforms / channels / featureGate).
    if (!evaluateCompatibility(entry.compatibility, ctx, diagnostics)) {
        return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
    }

    // policy.requiredFeatureIds / requiredPermissionIds / profileMode.
    const policy = asRecord(entry.policy);
    if (policy) {
        for (const requiredFeatureId of readStringArray(policy.requiredFeatureIds)) {
            if (!(ctx.isFeatureEnabled?.(requiredFeatureId) ?? false)) {
                diagnostics.push('required_feature_disabled');
                return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
            }
        }
        for (const requiredPermissionId of readStringArray(policy.requiredPermissionIds)) {
            if (!(ctx.isPermissionGranted?.(requiredPermissionId) ?? false)) {
                diagnostics.push('required_permission_missing');
                return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
            }
        }
        const requiredProfileMode = typeof policy.profileMode === 'string' ? policy.profileMode : '';
        if (requiredProfileMode.length > 0 && ctx.profileMode !== requiredProfileMode) {
            diagnostics.push('profile_mode_unsupported');
            return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
        }
    }

    const availability = evaluateContributionAvailability(entry.availability, ctx, diagnostics);
    if (!availability.visible) {
        return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
    }

    // visibility predicate — gates whether the entry renders at all.
    if (entry.visibility !== undefined) {
        if (!evaluatePluginUiPredicate(entry.visibility as UnknownRecord, ctx)) {
            diagnostics.push('visibility_predicate_false');
            return { visible: false, enabled: false, diagnostics: Object.freeze(diagnostics) };
        }
    }

    // enabled predicate — gates interactive state (still visible when false).
    let enabled = availability.enabled;
    if (entry.enabled !== undefined) {
        // A boolean `enabled` (browser action schema) is a literal flag; a
        // predicate object is evaluated against the context.
        if (typeof entry.enabled === 'boolean') {
            enabled = entry.enabled;
        } else {
            enabled = evaluatePluginUiPredicate(entry.enabled as UnknownRecord, ctx);
        }
        if (!enabled) {
            diagnostics.push('enabled_predicate_false');
        }
    }

    return { visible: true, enabled, diagnostics: Object.freeze(diagnostics) };
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
