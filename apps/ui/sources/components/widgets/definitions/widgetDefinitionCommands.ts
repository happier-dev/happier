import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, type PublicActionInputById, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import { randomUUID } from '@/platform/randomUUID';

/**
 * The definition, promotion and snapshot screens call the canonical `widgets.*` Actions — the very
 * operations an agent uses — and read back one of three facts: it happened (with the parsed result),
 * it is waiting for approval in the Inbox, or it was refused with a code. No screen writes an
 * Artifact or a Board item itself.
 */
export type WidgetDefinitionCommandOutcome<Result> =
    | Readonly<{ kind: 'applied'; result: Result }>
    | Readonly<{ kind: 'approvalPending' }>
    | Readonly<{ kind: 'refused'; errorCode: string }>;

type CommandId = Extract<ActionId,
    | 'widgets.definition.get'
    | 'widgets.definition.list'
    | 'widgets.definition.duplicate'
    | 'widgets.definition.saveFromSession'
    | 'widgets.instance.add'
    | 'widgets.instance.size.set'
    | 'widgets.instance.refresh'
    | 'widgets.snapshot.post'>;

/** The exact Home and Account the person is acting in; a call never drifts to another. */
export type WidgetCommandTarget = Readonly<{ serverId: string; accountId: string }>;

/** All widget Action adapters distinguish a committed result from approval custody. */
export function classifyWidgetDefinitionCommandResult<Id extends CommandId>(
    actionId: Id,
    result: ActionExecuteResult,
): WidgetDefinitionCommandOutcome<PublicActionResultById[Id]> {
    if (!result.ok) return { kind: 'refused', errorCode: result.errorCode ?? 'widget_command_failed' };
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return { kind: 'approvalPending' };
    const parsed = getActionSpec(actionId).outputSchema?.safeParse(result.result);
    if (!parsed?.success) return { kind: 'refused', errorCode: 'invalid_action_output' };
    return { kind: 'applied', result: parsed.data as PublicActionResultById[Id] };
}

export async function runWidgetDefinitionCommand<Id extends CommandId>(
    actionId: Id,
    input: PublicActionInputById[Id],
    target: WidgetCommandTarget,
    signal?: AbortSignal,
): Promise<WidgetDefinitionCommandOutcome<PublicActionResultById[Id]>> {
    try {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        // The person pressed it: present-user authority, one request id, so a consequential
        // operation enters the existing approval policy exactly as any other UI Action does.
        const result = await createDefaultActionExecutor().execute(actionId, input, {
            surface: 'ui', authority: 'present_user', serverId: target.serverId, expectedAccountId: target.accountId,
            actionRequestId: randomUUID(), ...(signal ? { signal } : {}),
        });
        return classifyWidgetDefinitionCommandResult(actionId, result);
    } catch (error) {
        if (signal?.aborted) return { kind: 'refused', errorCode: 'cancelled' };
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'widget_command_failed';
        return { kind: 'refused', errorCode: code };
    }
}
