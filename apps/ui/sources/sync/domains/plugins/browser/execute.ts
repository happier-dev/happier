import { PluginJsonValueV2Schema } from '@happier-dev/protocol';

import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy/evaluate';
import {
    machinePluginStructuredMessageActionExecute,
    type MachinePluginStructuredMessageActionResult,
} from '@/sync/ops/machineContributionRegistryProjection';

import {
    canUsePluginBrowserProjectionEntry,
    resolvePluginBrowserPolicyDecision,
} from './policy';
import type { PluginBrowserActionProjection, PluginBrowserProjectionModel } from './targets';

export type PluginBrowserActionTransport = typeof machinePluginStructuredMessageActionExecute;

export type ExecutePluginBrowserActionResult = Readonly<
    | { ok: true; result: unknown }
    | { ok: false; code: 'action_unavailable' | 'invalid_input' | 'runtime_unavailable' | 'execution_failed' }
>;

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
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id));
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

function resultFromTransport(
    result: MachinePluginStructuredMessageActionResult,
): ExecutePluginBrowserActionResult {
    if (!result.supported) {
        return { ok: false, code: 'runtime_unavailable' };
    }
    return result.result.ok
        ? { ok: true, result: result.result.result }
        : { ok: false, code: 'execution_failed' };
}

/**
 * Presentation-only browser adapter for the F03 action front door. Browser code never resolves,
 * activates, or invokes a plugin handler itself: it forwards the projection's qualified action id
 * and generation to the daemon, where `executePluginActionIfAvailable` remains the sole executor.
 */
export async function executePluginBrowserAction(params: Readonly<{
    action: PluginBrowserActionProjection | null | undefined;
    generation: number | null;
    machineId: string | null | undefined;
    serverId?: string | null;
    sessionId?: string | null;
    input: unknown;
    policyContext?: PluginUiPolicyEvaluationContext;
    execute?: PluginBrowserActionTransport;
}>): Promise<ExecutePluginBrowserActionResult> {
    const machineId = normalizeMachineId(params.machineId);
    if (
        !params.action
        || params.generation === null
        || !machineId
        || !canUsePluginBrowserProjectionEntry(params.action, params.policyContext)
    ) {
        return { ok: false, code: 'action_unavailable' };
    }
    const input = PluginJsonValueV2Schema.safeParse(params.input);
    if (!input.success) {
        return { ok: false, code: 'invalid_input' };
    }

    const result = await (params.execute ?? machinePluginStructuredMessageActionExecute)(machineId, {
        serverId: params.serverId,
        expectedGeneration: String(params.generation),
        qualifiedActionId: params.action.qualifiedActionId,
        input: input.data,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        executionSurface: 'ui',
    });
    return resultFromTransport(result);
}
