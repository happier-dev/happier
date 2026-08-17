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
