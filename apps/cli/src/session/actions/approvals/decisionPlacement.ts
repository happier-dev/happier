import {
  resolveApprovalExecutor,
  type ApprovalRequestV2,
} from '@happier-dev/protocol/approvals/approvalRequestV1';

export type CliApprovalDecisionPlacement =
  | Readonly<{ kind: 'local' }>
  | Readonly<{
      kind: 'origin';
      machineId: string;
      executor: ReturnType<typeof resolveApprovalExecutor>['kind'];
    }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Where a deciding CLI process carries an approved decision: its own executor,
 * or the origin daemon through the Machine transport. A forwarded Session Ask
 * keeps the Machine's signed execution carrier, which only that daemon can
 * sign for, so the CLI hands the decision to it instead of executing locally.
 */
export function resolveCliApprovalDecisionPlacement(
  input: Readonly<{
    request: ApprovalRequestV2;
    /** This process hosts Machine execution (daemon ingress or an owned plugin runtime). */
    hostsMachineExecution: boolean;
    /** A client port is reachable from this process for client-placed replays. */
    hasClientPort: boolean;
  }>,
): CliApprovalDecisionPlacement {
  const executor = resolveApprovalExecutor(input.request);
  if (executor.kind === 'unavailable') return { kind: 'unavailable' };
  const origin = input.request.executionOriginV1;
  const remoteClientReplay =
    executor.kind === 'app' &&
    executor.placement === 'client' &&
    !input.hasClientPort;
  const forwardedSessionAsk =
    executor.kind === 'app' &&
    !remoteClientReplay &&
    origin.externalActionExecutionAuthorization !== undefined &&
    origin.caller.kind === 'session';
  // Client delivery may have entered through local MCP control, without a
  // signed external carrier. A Session target retains its admitting Machine
  // separately; the target itself must remain the Session.
  const appMachineId = remoteClientReplay
    ? origin.target
      ? origin.target.kind === 'machine'
        ? origin.target.machineId
        : origin.machineId
      : undefined
    : forwardedSessionAsk
      ? (origin.machineId ??
        (origin.target?.kind === 'machine'
          ? origin.target.machineId
          : undefined))
      : undefined;
  if (remoteClientReplay && !appMachineId) return { kind: 'unavailable' };
  if (
    input.hostsMachineExecution ||
    (executor.kind === 'app' && !remoteClientReplay && !forwardedSessionAsk)
  ) {
    return { kind: 'local' };
  }
  const machineId =
    executor.kind === 'daemon'
      ? executor.machineId
      : executor.kind === 'live_invocation'
        ? executor.daemonMachineId
        : appMachineId;
  return machineId
    ? { kind: 'origin', machineId, executor: executor.kind }
    : { kind: 'unavailable' };
}
