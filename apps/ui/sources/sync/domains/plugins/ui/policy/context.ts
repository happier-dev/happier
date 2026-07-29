import type { PluginUiPolicyEvaluationContext } from './evaluate';

export type PluginUiPolicyEvaluationContextInput = PluginUiPolicyEvaluationContext | null | undefined;
type MutablePluginUiPolicyEvaluationContext = {
    -readonly [Key in keyof PluginUiPolicyEvaluationContext]?: PluginUiPolicyEvaluationContext[Key];
};

function isDefined<T>(value: T | null | undefined): value is T {
    return value !== undefined && value !== null;
}

export function createPluginUiPolicyEvaluationContext(
    ...contexts: readonly PluginUiPolicyEvaluationContextInput[]
): PluginUiPolicyEvaluationContext {
    const merged: MutablePluginUiPolicyEvaluationContext = {};
    for (const context of contexts) {
        if (!context) {
            continue;
        }
        if (isDefined(context.platform)) merged.platform = context.platform;
        if (isDefined(context.channel)) merged.channel = context.channel;
        if (isDefined(context.profileMode)) merged.profileMode = context.profileMode;
        if (context.isFeatureEnabled) merged.isFeatureEnabled = context.isFeatureEnabled;
        if (context.isPermissionGranted) merged.isPermissionGranted = context.isPermissionGranted;
        if (context.isCapabilityEnabled) merged.isCapabilityEnabled = context.isCapabilityEnabled;
        if ('data' in context) merged.data = context.data;
    }
    return Object.freeze(merged);
}
