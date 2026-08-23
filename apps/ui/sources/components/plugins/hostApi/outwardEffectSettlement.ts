import type {
    PluginUiHostApiResponseEnvelopeV1,
    PluginUiHostMethodV1,
} from '@happier-dev/protocol/plugins/ui';

/**
 * The host methods whose settlement is an OUTWARD EFFECT.
 *
 * By the time the mounted owner answers one of these, something outside the
 * plugin has already happened: a route was pushed, a draft was written, a
 * daemon Action ran, a notification was raised, the clipboard was replaced, an
 * external link was opened. The `result` is the record of that.
 *
 * The rest of the vocabulary is not like this. A read returns data the author
 * may no longer want, and `confirm`, `selectActionInput` and
 * `pickComposerMedia` return a DECISION to a question the mount can no longer
 * vouch for once it retires — delivering one of those from a dead mount would
 * report a choice against a surface that is gone.
 *
 * This is a projection of the Protocol vocabulary, not a second list of method
 * names: `satisfies` keeps every entry inside `PluginUiHostMethodV1`, so a
 * renamed or removed method fails to compile here instead of silently dropping
 * out of the classification.
 */
export const PLUGIN_UI_OUTWARD_EFFECT_HOST_METHODS_V1 = Object.freeze([
    'executeAction',
    'applyComposer',
    'focusComposer',
    'setComposerDecorations',
    'releaseComposerContent',
    'openSurface',
    'replacePageLocation',
    'notify',
    'writeClipboard',
    'openExternalLink',
] as const satisfies readonly PluginUiHostMethodV1[]);

const OUTWARD_EFFECT_HOST_METHODS = new Set<PluginUiHostMethodV1>(
    PLUGIN_UI_OUTWARD_EFFECT_HOST_METHODS_V1,
);

export function isPluginSurfaceOutwardEffectHostMethod(method: PluginUiHostMethodV1): boolean {
    return OUTWARD_EFFECT_HOST_METHODS.has(method);
}

/**
 * The ONE settlement rule both physical carriers apply: does a settlement the
 * mounted owner ALREADY produced survive a retirement the carrier only observes
 * afterwards?
 *
 * For an outward effect it must. `openSurface` is the case that proves it: the
 * navigation it performs routinely unmounts the very surface that requested it,
 * so the retirement is a CONSEQUENCE of the success. Answering that with
 * `stale_surface` tells the author nothing happened after something did, and
 * the only sane author response to "nothing happened" is to try again — a
 * second navigation, or a blind retry of a mutation that already ran. The
 * mounted Action dispatcher already states this rule for its own daemon
 * settlement; this is the same rule at the transport boundary.
 *
 * Everything else keeps the retirement check. A read, a `confirm` decision or a
 * selected form result are answers ABOUT a mount, and a retired mount cannot
 * vouch for them.
 *
 * The caller's own withdrawal is deliberately NOT decided here. An abort is a
 * different fact from a retirement — the author asked for the request to stop —
 * and each carrier already answers it with its own withdrawal semantics.
 *
 * This is a rule, not a mechanism: it owns no registry, receipt, timer or
 * identity, and reads only facts the carriers already hold.
 */
export function pluginSurfaceSettlementSurvivesRetirement(input: Readonly<{
    method: PluginUiHostMethodV1;
    response: PluginUiHostApiResponseEnvelopeV1;
}>): boolean {
    return input.response.kind === 'result'
        && isPluginSurfaceOutwardEffectHostMethod(input.method);
}
