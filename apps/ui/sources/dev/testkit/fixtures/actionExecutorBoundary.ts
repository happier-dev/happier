export { createActionExecutorBoundaryFixture } from '../../../../../../packages/tests/src/testkit/actionExecutorBoundary.js';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

/** A fixture host's Account and designed Confirm; protocol admission and transport ports stay real. */
export function createUiActionExecutorBoundary(deps: ActionExecutorDeps, accountId: string,
  actionsSettings?: ActionExecutorContext['actionsSettings']) {
  const executor = createActionExecutor(deps);
  const defaultSettings = normalizeActionsSettingsV1({ v: 1 });
  // The real UI host captures Account settings for ordinary admission as well as Confirm.
  const accountContext = (context: ActionExecutorContext | undefined): ActionExecutorContext => ({
    ...context, runtimeAccountId: accountId, actionCaller: context?.actionCaller ?? { kind: 'host' },
    authority: context?.authority ?? resolveInvocationAuthority({ credential: 'account', surface: 'ui' }),
    actionsSettings: actionsSettings ?? context?.actionsSettings ?? defaultSettings,
  });
  return {
    ...executor,
    execute: (...[actionId, input, context, ...rest]: Parameters<typeof executor.execute>) =>
      executor.execute(actionId, input, accountContext(context), ...rest),
    prepare: (...[actionId, input, context, ...rest]: Parameters<typeof executor.prepare>) =>
      executor.prepare(actionId, input, accountContext(context), ...rest),
    executeConfirmed: async (...[actionId, input, context]: Parameters<typeof executor.execute>) => {
      const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
      return executor.execute(actionId, input, bindPresentUserActionConfirmation(actionId, input, {
        ...accountContext(context), actionCaller: { kind: 'host' },
      }));
    },
  };
}
