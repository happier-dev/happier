import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';

import {
  applyMachineUpdates,
  planMachineUpdates,
  type MachineUpdatesScope,
} from './machineUpdatesActions';
import { useScopedActionRun } from './useScopedActionRun';

type Failure = Extract<ActionExecuteResult, { ok: false }>;

export type MachineUpdatePackage = Readonly<{
  name: string;
  version: string | null;
}>;

/**
 * One reviewed install: the Machine prepares the exact package plan (`machines.setup.plan`, effects), the person
 * installs exactly that plan (`machines.setup.updates.apply`, which asks first), and the accepted operation's own
 * lifecycle is the progress. Installing never restarts the Machine.
 */
export type MachineUpdatesReview =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'preparing';
      scope: MachineUpdatesScope;
      approval: ActionApprovalContinuation | null;
    }>
  | Readonly<{
      kind: 'review';
      scope: MachineUpdatesScope;
      plan: MachineSetupEffectPlanV1;
      packages: readonly MachineUpdatePackage[];
    }>
  /** The Machine found nothing to install for this scope when it planned. */
  | Readonly<{ kind: 'nothing'; scope: MachineUpdatesScope }>
  | Readonly<{
      kind: 'applying';
      scope: MachineUpdatesScope;
      plan: MachineSetupEffectPlanV1;
      packages: readonly MachineUpdatePackage[];
      approval: ActionApprovalContinuation | null;
    }>
  | Readonly<{
      kind: 'installing';
      scope: MachineUpdatesScope;
      operationId: string;
      count: number;
    }>
  | Readonly<{
      kind: 'settled';
      scope: MachineUpdatesScope;
      operationId: string;
      count: number;
      state: 'succeeded' | 'failed' | 'cancelled';
    }>
  | Readonly<{
      kind: 'failed';
      scope: MachineUpdatesScope;
      failure: Failure;
      during: 'prepare' | 'apply';
    }>;

const invalidOutput = (error: string): Failure => ({
  ok: false,
  errorCode: 'action_invalid_output',
  error,
});

export function readMachineUpdatePackages(
  plan: MachineSetupEffectPlanV1,
): readonly MachineUpdatePackage[] {
  return plan.steps.flatMap((step) =>
    step.kind === 'package'
      ? step.packages.map((item) => ({
          name: item.name,
          version: item.version ?? null,
        }))
      : [],
  );
}

export function useMachineUpdatesReview(
  input: Readonly<{
    serverId: string;
    machineId: string;
    /** Called once when an accepted install settles, so the page reads the Machine's facts again. */
    onSettled: () => void;
  }>,
) {
  const { lifetime, run, abort, inFlight } = useScopedActionRun(input.serverId);
  const [review, setReview] = React.useState<MachineUpdatesReview>({
    kind: 'idle',
  });

  React.useEffect(
    () => () => {
      abort();
      setReview({ kind: 'idle' });
    },
    [input.serverId, input.machineId, lifetime, abort],
  );

  const target = React.useMemo(
    () =>
      lifetime
        ? {
            serverId: input.serverId,
            homeId: lifetime.scope.serverId,
            machineId: input.machineId,
          }
        : null,
    [input.machineId, input.serverId, lifetime],
  );

  const prepare = React.useCallback(
    async (scope: MachineUpdatesScope) => {
      if (inFlight() || !target) return;
      setReview({ kind: 'preparing', scope, approval: null });
      const actionInput = {
        homeId: target.homeId,
        machineId: target.machineId,
        updates: { scope },
        mode: 'effects',
      };
      const result = await run(
        'machines.setup.plan',
        actionInput,
        (signal, bound) =>
          planMachineUpdates(target, scope, 'effects', {
            expectedAccountId: bound.scope.accountId,
            signal,
          }),
        (approval) => setReview({ kind: 'preparing', scope, approval }),
      );
      if (!result) return;
      if (!result.ok) {
        setReview({
          kind: 'failed',
          scope,
          failure: result,
          during: 'prepare',
        });
        return;
      }
      const parsed = ManagedMachineActionOutputSchemasV1[
        'machines.setup.plan'
      ].safeParse(result.result);
      const updates =
        parsed.success && 'updates' in parsed.data
          ? parsed.data.updates
          : undefined;
      if (!updates) {
        setReview({
          kind: 'failed',
          scope,
          failure: invalidOutput('machines.setup.plan'),
          during: 'prepare',
        });
        return;
      }
      const plan = updates.plan;
      const packages = plan ? readMachineUpdatePackages(plan) : [];
      setReview(
        plan && packages.length > 0
          ? { kind: 'review', scope, plan, packages }
          : { kind: 'nothing', scope },
      );
    },
    [inFlight, run, target],
  );

  const apply = React.useCallback(async () => {
    if (inFlight() || review.kind !== 'review' || !target) return;
    const { scope, plan, packages } = review;
    setReview({ kind: 'applying', scope, plan, packages, approval: null });
    const actionInput = {
      homeId: target.homeId,
      machineId: target.machineId,
      scope,
      plan,
    };
    const result = await run(
      'machines.setup.updates.apply',
      actionInput,
      (signal, bound) =>
        applyMachineUpdates(target, scope, plan, {
          expectedAccountId: bound.scope.accountId,
          signal,
        }),
      (approval) =>
        setReview({ kind: 'applying', scope, plan, packages, approval }),
    );
    if (!result) return;
    if (!result.ok) {
      setReview({ kind: 'failed', scope, failure: result, during: 'apply' });
      return;
    }
    const parsed = ManagedMachineActionOutputSchemasV1[
      'machines.setup.updates.apply'
    ].safeParse(result.result);
    setReview(
      parsed.success
        ? {
            kind: 'installing',
            scope,
            operationId: parsed.data.operationId,
            count: packages.length,
          }
        : {
            kind: 'failed',
            scope,
            failure: invalidOutput('machines.setup.updates.apply'),
            during: 'apply',
          },
    );
  }, [inFlight, review, run, target]);

  // The accepted operation's own lifecycle is the progress; its terminal state settles the review once.
  const operation = useActionOperation({
    serverId: review.kind === 'installing' ? input.serverId : null,
    operationId: review.kind === 'installing' ? review.operationId : '',
  });
  const operationState = operation?.snapshot.state ?? null;
  const { onSettled } = input;
  React.useEffect(() => {
    if (
      review.kind !== 'installing' ||
      !operationState ||
      !isActionOperationTerminal(operationState)
    )
      return;
    setReview({
      kind: 'settled',
      scope: review.scope,
      operationId: review.operationId,
      count: review.count,
      state:
        operationState === 'succeeded'
          ? 'succeeded'
          : operationState === 'cancelled'
            ? 'cancelled'
            : 'failed',
    });
    onSettled();
  }, [onSettled, operationState, review]);

  const cancel = React.useCallback(() => {
    abort();
    setReview({ kind: 'idle' });
  }, [abort]);

  return { review, prepare, apply, cancel };
}
