import {
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from './policy/evaluate';

type PluginUiProjectionEntry = Readonly<Record<string, unknown>>;

export type {
    PluginUiPolicyEvaluationContext,
    PluginUiPolicyDecision,
} from './policy/evaluate';
export {
    createPluginUiPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContextInput,
} from './policy/context';
export {
    evaluatePluginUiPolicy,
    evaluatePluginUiPredicate,
    isPluginUiPolicyVisible,
} from './policy/evaluate';

const DEFERRED_POLICY_FIELDS = [
    'visibility',
    'enabled',
    'featureGate',
    'compatibility',
] as const;

/**
 * Whether an entry DECLARES any host-evaluated policy field. Retained so the
 * projection/diagnostics surfaces can flag entries that depend on a host
 * evaluation context. This is no longer a "hide" predicate — declared policy is
 * EVALUATED (Phase 1.1) via `evaluatePluginUiPolicy`, not silently hidden.
 */
export function hasDeferredPluginUiPolicy(
    entry: PluginUiProjectionEntry | null | undefined,
): boolean {
    if (!entry) {
        return false;
    }
    return DEFERRED_POLICY_FIELDS.some((field) => entry[field] !== undefined);
}

/**
 * Canonical render gate for a plugin-UI projection entry. Replaces the old
 * accept-and-hide behavior: declared `visibility/enabled/featureGate/
 * compatibility` (and browser `policy.*`) are EVALUATED against the host
 * context and render conditionally.
 *
 * The context is optional so the many pure selectors/components that call this
 * keep working; when omitted, gating signals that REQUIRE a resolver
 * (featureGate, required features/permissions) fail closed, while
 * context-free predicates (platform/channel compatibility, data-shaped
 * predicates) still evaluate. Supply a context to enable full evaluation.
 */
export function canRenderPluginUiProjectionEntry(
    entry: PluginUiProjectionEntry | null | undefined,
    ctx: PluginUiPolicyEvaluationContext = {},
): boolean {
    if (!entry) {
        return false;
    }
    return evaluatePluginUiPolicy(entry, ctx).visible;
}
