import * as React from 'react';
import { isActionOutcomeUnknownErrorCodeV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MachineRebootResultV1Schema, type MachineRebootResultV1 } from '@happier-dev/protocol/actions/specs/machine/reboot';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { randomUUID } from '@/platform/randomUUID';
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
const rebootAction = 'machines.reboot';

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
  const [issued, setIssued] = React.useState<{
    requestId: string;
    lifetime: NonNullable<typeof lifetime>;
  } | null>(null);
  const { onSettled } = input;

  React.useEffect(
    () => () => {
      abort();
      setIssued(null);
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
    const requestId = randomUUID();
    setIssued(null);
    setReboot({ kind: 'starting', approval: null });
    const result = await run(
      rebootAction,
      actionInput,
      (signal, bound) =>
        execute(rebootAction, actionInput, {
          surface: 'ui',
          serverId: input.serverId,
          expectedAccountId: bound.scope.accountId,
          actionRequestId: requestId,
          signal,
          onTransportIssued: () => {
            if (!signal.aborted && bound.isCurrent()) setIssued({ requestId, lifetime: bound });
          },
        }),
      (approval) => setReboot({ kind: 'starting', approval }),
    );
    if (!result) return;
    if (!result.ok) {
      if (!isActionOutcomeUnknownErrorCodeV1(result.errorCode)) setIssued(null);
      setReboot(settleFailure(result));
      return;
    }
    setIssued(null);
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

  const accepted = reboot.kind === 'restarting' ? { serverId: input.serverId, operationId: reboot.operationId } : null;
  const operation = useActionOperation(accepted, {
    machineId: input.machineId,
    actionId: rebootAction,
    lifetime,
    requestId: issued && issued.lifetime === lifetime ? issued.requestId : undefined,
  });
  const operationId = operation?.snapshot.operationId;
  const operationState = operation?.snapshot.state;
  React.useEffect(() => {
    if (!operationId || !operationState || !isActionOperationTerminal(operationState) || !lifetime?.isCurrent()) return;
    abort();
    setIssued(null);
    setReboot({
      kind: 'settled',
      operationId,
      state:
        operationState === 'succeeded'
          ? 'succeeded'
          : operationState === 'cancelled'
            ? 'cancelled'
            : 'failed',
    });
    onSettled();
  }, [abort, lifetime, onSettled, operationId, operationState]);

  const dismiss = React.useCallback(() => {
    abort();
    setIssued(null);
    setReboot({ kind: 'idle' });
  }, [abort]);

  const visible: MachineSecurityReboot = operationId && operationState && !isActionOperationTerminal(operationState)
    ? { kind: 'restarting', operationId }
    : reboot;
  return { reboot: visible, start, dismiss };
}

/** Declining the confirmation is the person's choice, not a failure to show. */
function settleFailure(result: Failure): MachineSecurityReboot {
  return result.errorCode === 'approval_canceled' ||
    result.errorCode === 'approval_declined'
    ? { kind: 'idle' }
    : { kind: 'failed', code: result.errorCode };
}
