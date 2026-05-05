import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';

import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutor>[0];

export type RpcActionExecutor = Readonly<{
    execute: (
        actionId: ActionId,
        input: unknown,
        context?: ActionExecutorContext,
    ) => Promise<ActionExecuteResult>;
}>;

export type RpcActionDispatchRequest = Readonly<{
    actionId: ActionId;
    input: unknown;
    defaultSessionId?: string | null;
    serverId?: string | null;
    executor?: RpcActionExecutor;
    executorParams?: CliActionExecutorParams;
}>;

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function buildActionExecutorContextForRpc(
    params: Pick<RpcActionDispatchRequest, 'defaultSessionId' | 'serverId'>,
): ActionExecutorContext {
    const defaultSessionId = normalizeOptionalString(params.defaultSessionId);
    const serverId = normalizeOptionalString(params.serverId);

    return {
        ...(defaultSessionId ? { defaultSessionId } : {}),
        ...(serverId ? { serverId } : {}),
        surface: 'rpc',
    };
}

export function buildActionExecutorDepsForRpc(
    params: Readonly<{ executorParams: CliActionExecutorParams }>,
): CliActionExecutorParams {
    return params.executorParams;
}

function resolveRpcActionExecutor(params: RpcActionDispatchRequest): RpcActionExecutor {
    if (params.executor) {
        return params.executor;
    }
    if (!params.executorParams) {
        throw new Error('rpc_action_executor_params_required');
    }
    return createCliActionExecutor(buildActionExecutorDepsForRpc({ executorParams: params.executorParams }));
}

export async function dispatchActionFromRpc(
    params: RpcActionDispatchRequest,
): Promise<ActionExecuteResult> {
    const executor = resolveRpcActionExecutor(params);
    return await executor.execute(
        params.actionId,
        params.input,
        buildActionExecutorContextForRpc(params),
    );
}
