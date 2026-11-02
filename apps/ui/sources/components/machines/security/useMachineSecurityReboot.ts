import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineRebootResultV1Schema, type MachineRebootResultV1 } from '@happier-dev/protocol';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import {
  createFrontDoorActionExecute,
  type FrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { useScopedActionRun } from './useScopedActionRun';

type Failure = Extract<ActionExecuteResult, { ok: false }>;

/**
 * The separate restart (P30 `machines.reboot`): its own confirmation and approval, admission checked by the Machine
 * right before it dispatches, never started by installing updates. A blocked answer or the accepted operation's
 * terminal state settles it; either one asks the page to read the Machine's facts again.
 */
export type MachineSecurityReboot =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'starting'; approval: ActionApprovalContinuation | null }>
  | Readonly<{ kind: 'blocked'; reasons: Extract<MachineRebootResultV1, { kind: 'blocked' }>['reasons'] }>
  | Readonly<{ kind: 'restarting'; operationId: string }>
  | Readonly<{
      kind: 'settled';
      operationId: string;
      state: 'succeeded' | 'failed' | 'cancelled';
    }>
  | Readonly<{ kind: 'failed'; code: string }>;

const defaultExecute = createFrontDoorActionExecute();

export function useMachineSecurityReboot(
  input: Readonly<{
    serverId: string;
    machineId: string;
    installationId: string | null;
    onSettled: () => void;
    /** The Action front door; tests pass one built over the real executor with only the Machine RPC substituted. */
    execute?: FrontDoorActionExecute;
  }>,
) {
  const execute = input.execute ?? defaultExecute;
  const { lifetime, run, abort, inFlight } = useScopedActionRun(input.serverId);
  const [reboot, setReboot] = React.useState<MachineSecurityReboot>({
    kind: 'idle',
  });
  const { onSettled } = input;

  React.useEffect(
    () => () => {
      abort();
      setReboot({ kind: 'idle' });
    },
    [input.serverId, input.machineId, lifetime, abort],
  );

  const start = React.useCallback(async () => {
    if (inFlight() || !input.installationId) return;
    const actionInput = {
      serverId: input.serverId,
      machineId: input.machineId,
      expectedInstallationId: input.installationId,
    };
    setReboot({ kind: 'starting', approval: null });
    const result = await run(
      'machines.reboot',
      actionInput,
      (signal, bound) =>
        execute('machines.reboot', actionInput, {
          surface: 'ui',
          serverId: input.serverId,
          expectedAccountId: bound.scope.accountId,
          signal,
        }),
      (approval) => setReboot({ kind: 'starting', approval }),
    );
    if (!result) return;
    if (!result.ok) {
      setReboot(settleFailure(result));
      return;
    }
    const parsed = MachineRebootResultV1Schema.safeParse(result.result);
    if (!parsed.success) {
      setReboot({ kind: 'failed', code: 'action_invalid_output' });
      return;
    }
    const answer = parsed.data;
    switch (answer.kind) {
      case 'accepted':
        setReboot({
          kind: 'restarting',
          operationId: answer.operation.operationId,
        });
        return;
      case 'blocked':
        setReboot({ kind: 'blocked', reasons: answer.reasons });
        onSettled();
        return;
      case 'failed':
        setReboot({ kind: 'failed', code: answer.reasonCode });
        return;
      case 'unavailable':
        setReboot({ kind: 'failed', code: answer.reason });
        return;
    }
  }, [
    execute,
    inFlight,
    input.installationId,
    input.machineId,
    input.serverId,
    onSettled,
    run,
  ]);

  const operation = useActionOperation({
    serverId: reboot.kind === 'restarting' ? input.serverId : null,
    operationId: reboot.kind === 'restarting' ? reboot.operationId : '',
  });
  const operationState = operation?.snapshot.state ?? null;
  React.useEffect(() => {
    if (
      reboot.kind !== 'restarting' ||
      !operationState ||
      !isActionOperationTerminal(operationState)
    )
      return;
    setReboot({
      kind: 'settled',
      operationId: reboot.operationId,
      state:
        operationState === 'succeeded'
          ? 'succeeded'
          : operationState === 'cancelled'
            ? 'cancelled'
            : 'failed',
    });
    onSettled();
  }, [onSettled, operationState, reboot]);

  const dismiss = React.useCallback(() => {
    abort();
    setReboot({ kind: 'idle' });
  }, [abort]);

  return { reboot, start, dismiss };
}

/** Declining the confirmation is the person's choice, not a failure to show. */
function settleFailure(result: Failure): MachineSecurityReboot {
  return result.errorCode === 'approval_canceled' ||
    result.errorCode === 'approval_declined'
    ? { kind: 'idle' }
    : { kind: 'failed', code: result.errorCode };
}
