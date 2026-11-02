import * as React from 'react';
import {
  MachineReachabilityConfigureResultV1Schema,
  MachineReachabilityInspectResultV1Schema,
  type MachineReachabilityChangeV1,
  type MachineReachabilityConfigureResultV1,
  type MachineReachabilityPlanV1,
} from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import {
  resumeActionExecutionResult,
  type ActionApprovalContinuation,
} from '@/components/approvals/actionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import {
  configureMachineNetwork,
  inspectMachineNetwork,
} from './networkActions';
import {
  buildNetworkConfigureInput,
  buildNetworkInspectInput,
} from './networkSurface';

type Failure = Extract<ActionExecuteResult, { ok: false }>;

/**
 * One reviewed Network change: the host prepares the plan (inspect with the change), the person applies exactly
 * that plan (configure). Approval is the shared Action owner's; while a configure is in flight or waiting for
 * approval there is no second Apply.
 */
export type MachineNetworkReview =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'preparing';
      change: MachineReachabilityChangeV1;
      approval: ActionApprovalContinuation | null;
    }>
  | Readonly<{ kind: 'review'; plan: MachineReachabilityPlanV1 }>
  | Readonly<{
      kind: 'applying';
      plan: MachineReachabilityPlanV1;
      approval: ActionApprovalContinuation | null;
    }>
  | Readonly<{ kind: 'settled'; result: MachineReachabilityConfigureResultV1 }>
  | Readonly<{
      kind: 'failed';
      failure: Failure;
      plan: MachineReachabilityPlanV1 | null;
    }>;

const invalidOutput = (actionId: ActionId): Failure => ({
  ok: false,
  errorCode: 'action_invalid_output',
  error: actionId,
});

export function useMachineNetworkReview(
  input: Readonly<{ serverId: string; machineId: string }>,
) {
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(
    input.serverId,
  );
  const [review, setReview] = React.useState<MachineNetworkReview>({
    kind: 'idle',
  });
  const flight = React.useRef<AbortController | null>(null);

  // A change of Machine, Home or Account binding ends this review's interest; the durable approval stays put.
  React.useEffect(
    () => () => {
      flight.current?.abort();
      flight.current = null;
      setReview({ kind: 'idle' });
    },
    [input.serverId, input.machineId, lifetime],
  );

  const run = React.useCallback(
    async (
      actionId: ActionId,
      actionInput: unknown,
      invoke: (signal: AbortSignal) => Promise<ActionExecuteResult>,
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
          result: await invoke(controller.signal),
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
      // A cancelled or retired review settles nothing on screen.
      return controller.signal.aborted ? null : result;
    },
    [lifetime],
  );

  const prepare = React.useCallback(
    async (change: MachineReachabilityChangeV1) => {
      if (flight.current) return;
      const target = { serverId: input.serverId, machineId: input.machineId };
      setReview({ kind: 'preparing', change, approval: null });
      const result = await run(
        'machines.reachability.inspect',
        buildNetworkInspectInput(target, change),
        (signal) =>
          inspectMachineNetwork(target, change, {
            ...(lifetime
              ? { expectedAccountId: lifetime.scope.accountId }
              : {}),
            signal,
          }),
        (approval) => setReview({ kind: 'preparing', change, approval }),
      );
      if (!result) return;
      if (!result.ok) {
        setReview({ kind: 'failed', failure: result, plan: null });
        return;
      }
      const parsed = MachineReachabilityInspectResultV1Schema.safeParse(
        result.result,
      );
      const plan = parsed.success ? parsed.data.plan : undefined;
      setReview(
        plan
          ? { kind: 'review', plan }
          : {
              kind: 'failed',
              failure: invalidOutput('machines.reachability.inspect'),
              plan: null,
            },
      );
    },
    [input.machineId, input.serverId, lifetime, run],
  );

  const apply = React.useCallback(async () => {
    if (flight.current || review.kind !== 'review') return;
    const plan = review.plan;
    setReview({ kind: 'applying', plan, approval: null });
    const result = await run(
      'machines.reachability.configure',
      buildNetworkConfigureInput(input.serverId, plan),
      (signal) =>
        configureMachineNetwork(input.serverId, plan, {
          ...(lifetime ? { expectedAccountId: lifetime.scope.accountId } : {}),
          signal,
        }),
      (approval) => setReview({ kind: 'applying', plan, approval }),
    );
    if (!result) return;
    if (!result.ok) {
      setReview({ kind: 'failed', failure: result, plan });
      return;
    }
    const parsed = MachineReachabilityConfigureResultV1Schema.safeParse(
      result.result,
    );
    setReview(
      parsed.success
        ? { kind: 'settled', result: parsed.data }
        : {
            kind: 'failed',
            failure: invalidOutput('machines.reachability.configure'),
            plan,
          },
    );
  }, [input.serverId, lifetime, review, run]);

  const cancel = React.useCallback(() => {
    flight.current?.abort();
    flight.current = null;
    setReview({ kind: 'idle' });
  }, []);

  return { review, prepare, apply, cancel };
}
