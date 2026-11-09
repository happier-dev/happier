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
    createPluginUiSessionPolicyEvaluationContext,
    type PluginUiPolicyEvaluationContextInput,
    type PluginUiSessionPolicyFacts,
} from './policy/context';
export { createPluginUiProjectPolicyEvaluationContext } from './policy/projectContext';
export {
    evaluatePluginUiPolicy,
    isPluginUiPolicyVisible,
} from './policy/evaluate';

/**
 * Render gate for the canonical contribution availability expression. A
 * required fact without a host resolver fails closed.
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
