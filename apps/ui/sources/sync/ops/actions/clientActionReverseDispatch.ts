import {
    UiActionDispatchRequestV1Schema,
    parseClientActionDispatchResult,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { createDefaultActionExecutor } from './defaultActionExecutor';

/** Only the server-authenticated exact Machine may enter this admitted continuation. */
export function createUiClientActionReverseHandler(binding: Readonly<{
    serverId: string;
    accountId: string;
    isCurrent(): boolean;
}>) {
    const failure = (errorCode: string) => ({ v: 1 as const, execution: { ok: false as const, errorCode, error: errorCode } });
    return async (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => {
        const request = UiActionDispatchRequestV1Schema.safeParse(raw);
        if (!request.success) return failure('invalid_action_input');
        if (!binding.isCurrent() || !context || context.signal.aborted) return failure('target_unavailable');
        const { actionId, input, context: admitted } = request.data;
        const executor = createDefaultActionExecutor({ admittedClientActionId: actionId });
        try {
            const execution = await executor.execute(actionId, input, {
                ...admitted,
                serverId: binding.serverId,
                expectedAccountId: binding.accountId,
                signal: context.signal,
            });
            // Retirement cannot disclose the old Account's result to a replacement scope.
            // A lost issued response is uncertain, not proof that the effect did not run.
            if (!binding.isCurrent()) return failure('outcome_uncertain');
            const result = parseClientActionDispatchResult(actionId, { v: 1, execution });
            return result ? { v: 1 as const, execution: result } : failure('invalid_action_output');
        } catch {
            return failure('outcome_uncertain');
        }
    };
}
