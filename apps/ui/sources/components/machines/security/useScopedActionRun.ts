import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import {
  resumeActionExecutionResult,
  type ActionApprovalContinuation,
} from '@/components/approvals/actionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

type ScopedLifetime = NonNullable<ReturnType<typeof useServerCredentialAccountScopeBinding>['binding']>;

export type ScopedActionRunInvoke = (
  signal: AbortSignal,
  lifetime: ScopedLifetime,
) => Promise<ActionExecuteResult>;

/**
 * One Machine review's Action run: bound to the Home's current Account, resumed through the shared approval
 * continuation, and ended by cancel or by the Account binding retiring. A cancelled or retired run returns null
 * so nothing settles on screen; at most one run is in flight.
 */
export function useScopedActionRun(serverId: string) {
  const { binding: lifetime } =
    useServerCredentialAccountScopeBinding(serverId);
  const flight = React.useRef<AbortController | null>(null);

  const run = React.useCallback(
    async (
      actionId: ActionId,
      actionInput: unknown,
      invoke: ScopedActionRunInvoke,
      onApproval: (approval: ActionApprovalContinuation) => void,
    ): Promise<ActionExecuteResult | null> => {
      if (!lifetime)
        return {
          ok: false,
          errorCode: 'action_account_scope_changed',
          error: 'action_account_scope_changed',
        };
      const controller = new AbortController();
      flight.current = controller;
      const retirement = lifetime.onRetire(() => controller.abort());
      let result: ActionExecuteResult;
      try {
        result = await resumeActionExecutionResult({
          result: await invoke(controller.signal, lifetime),
          actionId,
          actionInput,
          scope: lifetime.scope,
          signal: controller.signal,
          onApprovalPending: (approval) => {
            if (!controller.signal.aborted) onApproval(approval);
          },
        });
      } catch (error: unknown) {
        result = {
          ok: false,
          errorCode: 'action_failed',
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        retirement.dispose();
        if (flight.current === controller) flight.current = null;
      }
      return controller.signal.aborted ? null : result;
    },
    [lifetime],
  );

  const abort = React.useCallback(() => {
    flight.current?.abort();
    flight.current = null;
  }, []);

  const inFlight = React.useCallback(() => flight.current !== null, []);

  return { lifetime, run, abort, inFlight };
}
