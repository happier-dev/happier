import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  MachineAdminAccessMutationResultV1Schema,
  type MachineAdminAccessV1,
} from '@happier-dev/protocol/machines/adminAccessV1';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import {
  createFrontDoorActionExecute,
  type FrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { buildAdminAccessSetInput } from './adminPower';
import { useScopedActionRun } from './useScopedActionRun';

/**
 * Saving a new administrator access choice: one `machines.setup.adminAccess.set` with the policy the person saw as
 * its expectation, so a change made elsewhere comes back as a conflict instead of being overwritten. The Action's
 * own confirmation and approval are the review; the saved policy then arrives through the pushed metadata.
 */
export type MachineAdminAccessSave =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'saving'; approval: ActionApprovalContinuation | null }>
  | Readonly<{ kind: 'saved' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'failed'; code: string; message?: string }>;

const defaultExecute = createFrontDoorActionExecute();

export function useMachineAdminAccessSave(
  input: Readonly<{
    serverId: string;
    machineId: string;
    /** The Action front door; tests pass one built over the real executor with only the Machine RPC substituted. */
    execute?: FrontDoorActionExecute;
  }>,
) {
  const execute = input.execute ?? defaultExecute;
  const { lifetime, run, abort, inFlight } = useScopedActionRun(input.serverId);
  const [save, setSave] = React.useState<MachineAdminAccessSave>({
    kind: 'idle',
  });

  React.useEffect(
    () => () => {
      abort();
      setSave({ kind: 'idle' });
    },
    [input.serverId, input.machineId, lifetime, abort],
  );

  const submit = React.useCallback(
    async (
      saved: MachineAdminAccessV1,
      next: MachineAdminAccessV1,
      metadataVersion: number,
    ) => {
      if (inFlight()) return;
      const actionInput = buildAdminAccessSetInput({
        serverId: input.serverId,
        machineId: input.machineId,
        metadataVersion,
        saved,
        next,
      });
      setSave({ kind: 'saving', approval: null });
      const result = await run(
        'machines.setup.adminAccess.set',
        actionInput,
        (signal, bound) =>
          execute('machines.setup.adminAccess.set', actionInput, {
            surface: 'ui',
            serverId: input.serverId,
            expectedAccountId: bound.scope.accountId,
            signal,
          }),
        (approval) => setSave({ kind: 'saving', approval }),
      );
      if (!result) return;
      setSave(settleAdminAccessSave(result));
    },
    [execute, inFlight, input.machineId, input.serverId, run],
  );

  const reset = React.useCallback(() => {
    abort();
    setSave({ kind: 'idle' });
  }, [abort]);

  return { save, submit, reset };
}

export function settleAdminAccessSave(result: ActionExecuteResult): MachineAdminAccessSave {
  if (!result.ok) {
    // Declining the confirmation is the person's choice, not a failure to show.
    return result.errorCode === 'approval_canceled' ||
      result.errorCode === 'approval_declined'
      ? { kind: 'idle' }
      : { kind: 'failed', code: result.errorCode,
          message: resolveActionExecutionFailureMessage(result, '') || undefined };
  }
  const parsed = MachineAdminAccessMutationResultV1Schema.safeParse(
    result.result,
  );
  if (!parsed.success) return { kind: 'failed', code: 'action_invalid_output' };
  const answer = parsed.data;
  if ('effect' in answer && answer.effect?.outcome === 'not_applied') {
    const effect = answer.effect;
    return effect.reasonCode === 'cancelled' ? { kind: 'idle' }
      : { kind: 'failed', code: effect.reasonCode,
          message: resolveActionExecutionErrorMessage({ code: effect.reasonCode, failure: effect.failure }, '') || undefined };
  }
  if (
    answer.status === 'applied' ||
    answer.status === 'satisfied' ||
    answer.status === 'unchanged'
  )
    return { kind: 'saved' };
  if (answer.status === 'conflict') return { kind: 'conflict' };
  return answer.status === 'cancelled'
    ? { kind: 'idle' }
    : { kind: 'failed', code: answer.status };
}
