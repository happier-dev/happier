import {
  enforceExternalActionResponseEnvelopeLimitV1,
  type ExternalActionDaemonDispatchResultV1,
  ExternalActionRequestEnvelopeV1Schema,
  PublicActionIdSchema,
  projectExternalActionExecutionResultV1,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ExternalActionTargetV1,
  type PublicActionId,
} from '@happier-dev/protocol/actions';

import { reconcileExternalActionTarget } from './reconcileExternalActionTarget';

export type ExternalActionPrincipal = Readonly<{
  accountId: string;
  principalId: string;
  credentialId: string;
  authority: 'account_automation';
}>;

export type ExternalActionExecutor = Readonly<{
  execute: (
    actionId: PublicActionId,
    input: unknown,
    context?: ActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>;

/**
 * The daemon's target owner resolves the request target immediately before the
 * canonical Action executor runs. `null` means this daemon must not execute it.
 */
export type ResolveExternalActionTarget = (input: Readonly<{
  actionId: PublicActionId;
  target: ExternalActionTargetV1 | undefined;
  currentMachineId: string;
  signal?: AbortSignal;
}>) => Promise<ExternalActionTargetV1 | null>;

export type ExecuteExternalActionResult = ExternalActionDaemonDispatchResultV1;

/**
 * Transport-neutral external Action admission. Authentication and target
 * ownership are supplied by the daemon boundary; callers cannot set Action
 * authority, caller provenance, or execution context through the envelope.
 */
export async function executeExternalAction(input: Readonly<{
  actionId: unknown;
  envelope: unknown;
  principal: ExternalActionPrincipal;
  currentMachineId: string;
  /** Daemon-owned active server identity; never accepted from the envelope. */
  currentServerId?: string;
  resolveTarget: ResolveExternalActionTarget;
  executor: ExternalActionExecutor;
  signal?: AbortSignal;
}>): Promise<ExecuteExternalActionResult> {
  const actionId = PublicActionIdSchema.safeParse(input.actionId);
  if (!actionId.success) {
    return { kind: 'invalid_request', errorCode: 'invalid_action' };
  }

  const envelope = ExternalActionRequestEnvelopeV1Schema.safeParse(input.envelope);
  if (!envelope.success) {
    return { kind: 'invalid_request', errorCode: 'invalid_envelope' };
  }

  const reconciliation = reconcileExternalActionTarget({
    actionId: actionId.data,
    rawInput: envelope.data.input,
    target: envelope.data.target,
    currentMachineId: input.currentMachineId,
  });
  if (reconciliation.kind === 'rejected') {
    return {
      kind: 'response',
      response: {
        v: 1,
        actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: reconciliation.execution,
      },
    };
  }

  // The final target resolver is deliberately after parsed-input reconciliation
  // so an explicit or input-derived Session is proved current immediately
  // before the canonical Action executor runs.
  const target = await input.resolveTarget({
    actionId: actionId.data,
    target: reconciliation.target,
    currentMachineId: input.currentMachineId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!target) {
    return {
      kind: 'response',
      response: {
        v: 1,
        actionId: actionId.data,
        ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
        execution: targetNotLocal(),
      },
    };
  }

  const context: ActionExecutorContext = {
    surface: 'api',
    authority: input.principal.authority,
    actionCaller: { kind: 'host' },
    externalActionCredential: {
      accountId: input.principal.accountId,
      principalId: input.principal.principalId,
      credentialId: input.principal.credentialId,
    },
    externalActionTarget: target,
    ...(input.currentServerId !== undefined ? { serverId: input.currentServerId } : {}),
    ...reconciliation.context,
    ...(reconciliation.executionRunRequiresMachineTarget && target.kind === 'machine'
      ? { executionRunTargetMachineId: target.machineId }
      : {}),
    ...(envelope.data.requestId ? { actionRequestId: envelope.data.requestId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const internalExecution = await input.executor.execute(actionId.data, envelope.data.input, context);
  const execution = projectExternalActionExecutionResultV1(internalExecution) ?? {
    ok: false as const,
    errorCode: 'invalid_action_output',
    error: 'invalid_action_output',
  };

  return {
    kind: 'response',
    response: enforceExternalActionResponseEnvelopeLimitV1({
      v: 1,
      actionId: actionId.data,
      ...(envelope.data.requestId ? { requestId: envelope.data.requestId } : {}),
      execution,
    }),
  };
}

function targetNotLocal(): ActionExecuteResult {
  return {
    ok: false,
    errorCode: 'target_not_local',
    error: 'target_not_local',
  };
}
