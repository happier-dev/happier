export { createActionExecutorBoundaryFixture } from '../../../../../../packages/tests/src/testkit/actionExecutorBoundary.js';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

/** A fixture host's Account and designed Confirm; protocol admission and transport ports stay real. */
export function createUiActionExecutorBoundary(deps: ActionExecutorDeps, accountId: string,
  actionsSettings?: ActionExecutorContext['actionsSettings']) {
  const executor = createActionExecutor(deps);
  return {
    ...executor,
    executeConfirmed: async (...[actionId, input, context]: Parameters<typeof executor.execute>) => {
      const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
      return executor.execute(actionId, input, bindPresentUserActionConfirmation(actionId, input, {
        ...context, runtimeAccountId: accountId, actionCaller: { kind: 'host' },
        ...(actionsSettings ? { actionsSettings } : {}),
      }));
    },
  };
}
