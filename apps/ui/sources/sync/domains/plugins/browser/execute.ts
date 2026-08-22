import { PluginJsonValueV2Schema } from '@happier-dev/protocol';
import type {
    CurrentUiContextSnapshotV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy/evaluate';
import { comparePluginContributionOrder } from '@/sync/domains/plugins/contributionOrder';
import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceActionDispatchOutcome,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceContributedActionTransport,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginActionCurrentIntentHandler,
} from '@/components/plugins/surfaces/pluginSurfaceFeedback';

import {
    canUsePluginBrowserProjectionEntry,
    resolvePluginBrowserPolicyDecision,
} from './policy';
import type { PluginBrowserActionProjection, PluginBrowserProjectionModel } from './targets';

export type PluginBrowserActionTransport = PluginSurfaceContributedActionTransport;

export type PluginBrowserActionPlacement = PluginBrowserActionProjection['placement'];

export function selectPluginBrowserActionsForPlacement(params: Readonly<{
    projection: PluginBrowserProjectionModel | null | undefined;
    targetId: string | null | undefined;
    placement: PluginBrowserActionPlacement;
    policyContext?: PluginUiPolicyEvaluationContext;
}>): readonly PluginBrowserActionProjection[] {
    if (!params.projection || !params.targetId) {
        return [];
    }
    return Object.values(params.projection.actionsById)
        .filter((action) => (
            action.placement === params.placement
            && action.targetId === params.targetId
            && resolvePluginBrowserPolicyDecision(action, params.policyContext).visible
        ))
        .sort(comparePluginContributionOrder);
}

export function selectPluginBrowserToolbarActions(
    params: Omit<Parameters<typeof selectPluginBrowserActionsForPlacement>[0], 'placement'>,
): readonly PluginBrowserActionProjection[] {
    return selectPluginBrowserActionsForPlacement({ ...params, placement: 'toolbar' });
}

function normalizeMachineId(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : null;
}

/**
 * Presentation-only browser adapter for the contributed-action front door
 * (EU-5c). Browser code never resolves, activates or invokes a plugin handler:
 * it decides only whether this browser placement may show the contribution, then
 * hands the resolved identity to `dispatchPluginSurfaceAction`.
 *
 * The daemon request, the `executionSurface: 'ui'` stamp and the typed failure
 * vocabulary previously lived here as a fourth private copy. They are the
 * canonical dispatcher's, so a browser action and a mounted plugin surface can
 * no longer disagree about what a contributed action invocation is.
 */
export async function executePluginBrowserAction(params: Readonly<{
    action: PluginBrowserActionProjection | null | undefined;
    generation: number | null;
    machineId: string | null | undefined;
    serverId?: string | null;
    sessionId?: string | null;
    input: unknown;
    policyContext?: PluginUiPolicyEvaluationContext;
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    execute?: PluginBrowserActionTransport;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
}>): Promise<PluginSurfaceActionDispatchOutcome> {
    const machineId = normalizeMachineId(params.machineId);
    if (
        !params.action
        || params.generation === null
        || !canUsePluginBrowserProjectionEntry(params.action, params.policyContext)
    ) {
        return { ok: false, code: 'unavailable', reason: 'plugin_browser_action_unavailable' };
    }
    const input = PluginJsonValueV2Schema.safeParse(params.input);
    if (!input.success) {
        return { ok: false, code: 'invalid_payload', reason: 'plugin_browser_action_input_invalid' };
    }

    // This adapter reads the raw descriptor only to retain its browser-specific
    // daemon-context precondition. The canonical dispatcher remains the sole
    // owner of target selection and client-action failure semantics.
    const projectedAction = params.resolveContributedAction?.(params.action.actionIdentity) ?? null;
    if (projectedAction?.execution.target === 'daemon' && !machineId) {
        return { ok: false, code: 'unavailable', reason: 'plugin_browser_action_unavailable' };
    }
    const isCurrent = params.isCurrent ?? (() => true);
    const requestCurrentIntent = projectedAction?.execution.target === 'client'
        ? createPluginActionCurrentIntentHandler({
            requester: {
                pluginId: projectedAction.pluginId,
                contributionId: projectedAction.id,
                generationId: String(params.generation),
                invocationId: `ui-action:${params.generation}`,
            },
            ...(params.signal ? { signal: params.signal } : {}),
            isCurrent,
        })
        : undefined;

    return await dispatchPluginSurfaceAction({
        callerPluginId: params.action.pluginId,
        action: params.action.actionIdentity,
        input: input.data as PluginUiJsonValueV1,
        ...(params.resolveContributedAction
            ? { resolveContributedAction: params.resolveContributedAction }
            : {}),
        ...(projectedAction?.execution.target === 'daemon'
            ? {
                contributedAction: {
                    machineId: machineId!,
                    serverId: params.serverId ?? null,
                    expectedGeneration: String(params.generation),
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                    ...(params.execute ? { execute: params.execute } : {}),
                },
            }
            : {}),
        ...(projectedAction?.execution.target === 'client'
            && typeof params.generation === 'number'
            && Number.isInteger(params.generation)
            && params.generation >= 0
            ? {
                clientAction: {
                    projectionGeneration: params.generation,
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                    ...(requestCurrentIntent ? { requestCurrentIntent } : {}),
                    ...(params.readCurrentUiContext
                        ? { currentUiContext: params.readCurrentUiContext }
                        : {}),
                },
            }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        isCurrent,
    });
}
