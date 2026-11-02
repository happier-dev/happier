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

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

import { useScopedActionRun } from '../useScopedActionRun';

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
  const { lifetime, run, abort, inFlight } = useScopedActionRun(input.serverId);
  const [review, setReview] = React.useState<MachineNetworkReview>({
    kind: 'idle',
  });

  // A change of Machine, Home or Account binding ends this review's interest; the durable approval stays put.
  React.useEffect(
    () => () => {
      abort();
      setReview({ kind: 'idle' });
    },
    [input.serverId, input.machineId, lifetime, abort],
  );

  const prepare = React.useCallback(
    async (change: MachineReachabilityChangeV1) => {
      if (inFlight()) return;
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
    if (inFlight() || review.kind !== 'review') return;
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
    abort();
    setReview({ kind: 'idle' });
  }, [abort]);

  return { review, prepare, apply, cancel };
}
