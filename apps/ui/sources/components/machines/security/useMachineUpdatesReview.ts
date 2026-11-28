import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionOperationFailureV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineActionOutputSchemasV1, type MachineSetupPlanReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupEffectPlanV1, MachineSetupPackageHoldV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useInStepActionConfirmation, type InStepActionConfirmation } from '@/components/approvals/useInStepActionConfirmation';
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
 * One reviewed package change. The Machine prepares the exact effects, and the accepted Apply operation reports progress.
 */
export type MachineUpdatesReview =
  | Readonly<{ kind: 'idle' }>
  | (Readonly<{ scope: MachineUpdatesScope; hold?: MachineSetupPackageHoldV1 }> & (
  Readonly<{
      kind: 'preparing';
      approval: ActionApprovalContinuation | null;
    }>
  | Readonly<{
      kind: 'review';
      plan: MachineSetupEffectPlanV1;
      packages: readonly MachineUpdatePackage[];
      setupReview?: MachineSetupPlanReviewV1;
      canHold?: boolean;
    }>
  /** The Machine found nothing to install for this scope when it planned. */
  | Readonly<{ kind: 'nothing' }>
  | Readonly<{
      kind: 'applying';
      plan: MachineSetupEffectPlanV1;
      packages: readonly MachineUpdatePackage[];
      approval: ActionApprovalContinuation | null;
      /** The Machine's own review of this install, answered by this step's Install press. */
      confirmation: InStepActionConfirmation | null;
    }>
  | Readonly<{
      kind: 'installing';
      operationId: string;
      count: number;
    }>
  | Readonly<{
      kind: 'settled';
      operationId: string;
      count: number;
      state: 'succeeded' | 'failed' | 'cancelled';
      failure?: ActionOperationFailureV1;
    }>
  | Readonly<{
      kind: 'failed';
      failure: Failure;
      during: 'prepare' | 'apply';
    }>));

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
  const stepConfirmation = useInStepActionConfirmation();
  const { confirm, answer } = stepConfirmation;
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
    async (scope: MachineUpdatesScope, hold?: MachineSetupPackageHoldV1) => {
      if (inFlight() || !target) return;
      const intent = { scope, ...(hold ? { hold } : {}) };
      setReview({ kind: 'preparing', ...intent, approval: null });
      const actionInput = {
        homeId: target.homeId,
        machineId: target.machineId,
        updates: intent,
        mode: 'effects',
      };
      const result = await run(
        'machines.setup.plan',
        actionInput,
        (signal, bound) =>
          planMachineUpdates(target, scope, 'effects', {
            expectedAccountId: bound.scope.accountId,
            signal,
          }, hold),
        (approval) => setReview({ kind: 'preparing', ...intent, approval }),
      );
      if (!result) return;
      if (!result.ok) {
        setReview({
          kind: 'failed',
          ...intent,
          failure: result,
          during: 'prepare',
        });
        return;
      }
      const parsed = ManagedMachineActionOutputSchemasV1[
        'machines.setup.plan'
      ].safeParse(result.result);
      const planned =
        parsed.success && 'updates' in parsed.data
          ? parsed.data
          : undefined;
      const updates = planned?.updates;
      if (!updates) {
        setReview({
          kind: 'failed',
          ...intent,
          failure: invalidOutput('machines.setup.plan'),
          during: 'prepare',
        });
        return;
      }
      const plan = updates.plan;
      const holdStep = plan?.steps.find(step => step.kind === 'packageHold');
      const holdFact = plan?.nativeFacts[0];
      if (hold && (!holdStep || holdStep.name !== hold.name || holdStep.operation !== hold.operation
        || holdFact?.status === 'unavailable' || holdFact?.status === 'unsupported')) {
        const reason = holdFact?.reason ?? updates.observation.reason ?? 'required_fact_unavailable';
        setReview({ kind: 'failed', ...intent, during: 'prepare', failure: { ok: false, errorCode: reason, error: reason } });
        return;
      }
      const packages = plan ? readMachineUpdatePackages(plan) : [];
      setReview(
        plan && (hold || packages.length > 0)
          ? { kind: 'review', ...intent, plan, packages, canHold: updates.observation.heldPackages !== undefined,
              ...(planned?.review ? { setupReview: planned.review } : {}) }
          : { kind: 'nothing', ...intent },
      );
    },
    [inFlight, run, target],
  );

  const apply = React.useCallback(async () => {
    // The Machine's carried review is on this step: Install answers it.
    if (stepConfirmation.pending) {
      answer(true);
      return;
    }
    if (inFlight() || review.kind !== 'review' || !target) return;
    const { scope, hold, plan, packages } = review;
    const intent = { scope, ...(hold ? { hold } : {}) };
    setReview({ kind: 'applying', ...intent, plan, packages, approval: null, confirmation: null });
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
        }, confirm),
      (approval) =>
        setReview({ kind: 'applying', ...intent, plan, packages, approval, confirmation: null }),
    );
    if (!result) return;
    if (!result.ok) {
      setReview({ kind: 'failed', ...intent, failure: result, during: 'apply' });
      return;
    }
    const parsed = ManagedMachineActionOutputSchemasV1[
      'machines.setup.updates.apply'
    ].safeParse(result.result);
    setReview(
      parsed.success
        ? {
            kind: 'installing',
            ...intent,
            operationId: parsed.data.operationId,
            count: packages.length,
          }
        : {
            kind: 'failed',
            ...intent,
            failure: invalidOutput('machines.setup.updates.apply'),
            during: 'apply',
          },
    );
  }, [answer, confirm, inFlight, review, run, stepConfirmation.pending, target]);

  // The accepted operation's own lifecycle is the progress; its terminal state settles the review once.
  const operation = useActionOperation({
    serverId: review.kind === 'installing' ? input.serverId : null,
    operationId: review.kind === 'installing' ? review.operationId : '',
  }, { machineId: input.machineId, actionId: 'machines.setup.updates.apply', lifetime });
  const operationState = operation?.snapshot.state ?? null;
  const operationFailure = operation?.snapshot.error;
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
      ...(review.hold ? { hold: review.hold } : {}),
      operationId: review.operationId,
      count: review.count,
      failure: operationFailure,
      state:
        operationState === 'succeeded'
          ? 'succeeded'
          : operationState === 'cancelled'
            ? 'cancelled'
            : 'failed',
    });
    onSettled();
  }, [onSettled, operationFailure, operationState, review]);

  const cancel = React.useCallback(() => {
    answer(false);
    abort();
    setReview({ kind: 'idle' });
  }, [abort, answer]);

  const shown = React.useMemo((): MachineUpdatesReview => review.kind === 'applying' && review.confirmation !== stepConfirmation.pending
    ? { ...review, confirmation: stepConfirmation.pending } : review, [review, stepConfirmation.pending]);
  return { review: shown, prepare, apply, cancel };
}
