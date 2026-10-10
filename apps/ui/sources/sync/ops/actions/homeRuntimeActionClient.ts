import { HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1, type HomeRuntimeActionIdV1 } from '@happier-dev/protocol/home/runtime/actionsV1';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import type { UiActionExecutorContext } from './defaultActionExecutor';

/** UI consumers keep the existing runner lifecycle after canonical Action admission. */
export function createUiHomeRuntimeActionClient(runner?: SystemTaskRunner) {
    const execute = createFrontDoorActionExecute(undefined, runner ? { homeRuntimeRunner: runner } : undefined);
    return async (actionId: HomeRuntimeActionIdV1, input: unknown, context?: UiActionExecutorContext) => {
        const result = await execute(actionId, input, { ...context, surface: 'ui' });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        return HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result);
    };
}
