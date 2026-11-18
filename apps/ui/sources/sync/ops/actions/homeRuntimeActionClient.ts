import { HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1, type HomeRuntimeActionIdV1 } from '@happier-dev/protocol/home/runtime/actionsV1';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { requireActionSuccess } from './actionResult';
import { resolveActionExecutionErrorMessage } from './resolveActionExecutionFailureMessage';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import type { createDefaultActionExecutor, UiActionExecutorContext } from './defaultActionExecutor';

/** UI consumers keep the existing runner lifecycle after canonical Action admission. */
export function createUiHomeRuntimeActionClient(runner?: SystemTaskRunner, admittedExecute?: ReturnType<typeof createDefaultActionExecutor>['execute']) {
    const execute = admittedExecute ?? createFrontDoorActionExecute(undefined, runner ? { homeRuntimeRunner: runner } : undefined);
    return async (actionId: HomeRuntimeActionIdV1, input: unknown, context?: UiActionExecutorContext) => {
        let result = await execute(actionId, input, { ...context, surface: 'ui' });
        if (!result.ok) {
            result = { ...result, error: resolveActionExecutionErrorMessage(result, result.error) };
            requireActionSuccess(result);
        }
        return HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result);
    };
}
