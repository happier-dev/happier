import { PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE, PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import type { PluginDiagnosticRemediationV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import type { PluginUiHostApiErrorCodeV1, PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';

export type PluginSurfaceActionDispatchOutcome =
    | Readonly<{ ok: true; result: PluginUiJsonValueV1 }>
    | Readonly<{
        ok: false;
        code: PluginUiHostApiErrorCodeV1;
        reason: string;
        message?: string;
        retryable?: boolean;
        remediation?: PluginDiagnosticRemediationV1;
    }>;

type PluginSurfaceActionDispatchFailure = Extract<PluginSurfaceActionDispatchOutcome, Readonly<{ ok: false }>>;

export function createPluginSurfaceActionFailure(
    code: PluginUiHostApiErrorCodeV1,
    reason: string,
    author?: Readonly<{
        message?: string;
        retryable?: boolean;
        remediation?: PluginDiagnosticRemediationV1;
    }>,
): PluginSurfaceActionDispatchFailure {
    return {
        ok: false,
        code,
        reason,
        ...(author?.message === undefined ? {} : { message: author.message }),
        ...(author?.retryable === undefined ? {} : { retryable: author.retryable }),
        ...(author?.remediation === undefined ? {} : { remediation: author.remediation }),
    };
}

export function clientActionFailure(
    code: string,
    author?: Readonly<{
        message?: string;
        retryable?: boolean;
        remediation?: PluginDiagnosticRemediationV1;
    }>,
): PluginSurfaceActionDispatchOutcome {
    return actionDeclinedFailure(code) ?? createPluginSurfaceActionFailure(
        code === 'plugin_action_generation_retired' ? 'stale_surface' : 'unavailable',
        code,
        author,
    );
}

/**
 * Projects a present-user DECLINE onto the typed `denied` host code.
 *
 * A decline is a decision, not an absence. Settling it as `unavailable` makes a
 * deliberate "no" indistinguishable from "this Action is not available right
 * now", which invites an autonomous caller (Voice) to ask the same person
 * again. The rejection code is minted by the canonical current-intent gate, so
 * both the client-target and daemon-target settlements recognise it here.
 */
export function actionDeclinedFailure(
    code: string,
): PluginSurfaceActionDispatchOutcome | null {
    return code === PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE
        ? createPluginSurfaceActionFailure('denied', code)
        : null;
}

/** Maps the canonical indeterminate Action code to Voice's private terminal fact. */
export function actionOutcomeUnknownFailure(
    code: string,
): PluginSurfaceActionDispatchOutcome | null {
    return code === PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        ? createPluginSurfaceActionFailure('timeout', 'plugin_ui_action_outcome_unknown')
        : null;
}
