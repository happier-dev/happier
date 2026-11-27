import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionOperationFailureV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createScheduledMachineUpdatesRolloutWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/machineUpdatesV1';
import type { WorkflowFailurePolicy } from '@happier-dev/protocol/workflows/workflowV1';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useInStepActionConfirmation } from '@/components/approvals/useInStepActionConfirmation';
import { randomUUID } from '@/platform/randomUUID';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { createWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';

import {
  planMachineUpdates,
  rolloutMachineUpdates,
  type MachineUpdatesScope,
} from '../security/machineUpdatesActions';
import {
  readMachineUpdatePackages,
  type MachineUpdatePackage,
} from '../security/useMachineUpdatesReview';
import { useScopedActionRun } from '../security/useScopedActionRun';
import {
  buildFleetRolloutInput,
  type FleetMachine,
  type FleetPlannedTarget,
} from './machineFleetUpdates';

type Failure = Extract<ActionExecuteResult, { ok: false }>;

export type FleetReviewedTarget = FleetPlannedTarget &
  Readonly<{ packages: readonly MachineUpdatePackage[] }>;

/**
 * The fleet rollout's lifecycle: each Machine prepares its exact plan (`machines.setup.plan`, effects) one after
 * another, the person reviews them together, then one `machines.setup.updates.rollout` installs them, or a saved
 * Workflow runs the same reviewed input later. The accepted operation's own lifecycle is the progress.
 */
export type FleetRollout =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
      kind: 'preparing';
      scope: MachineUpdatesScope;
      machine: string;
      approval: ActionApprovalContinuation | null;
    }>
  | Readonly<{
      kind: 'review';
      scope: MachineUpdatesScope;
      targets: readonly FleetReviewedTarget[];
      nothing: readonly string[];
    }>
  | Readonly<{
      kind: 'starting';
      scope: MachineUpdatesScope;
      targets: readonly FleetReviewedTarget[];
      approval: ActionApprovalContinuation | null;
      later: boolean;
    }>
  | Readonly<{ kind: 'rolling'; operationId: string; machineId: string; count: number }>
  | Readonly<{
      kind: 'settled';
      operationId: string;
      count: number;
      state: 'succeeded' | 'failed' | 'cancelled';
      failure?: ActionOperationFailureV1;
    }>
  | Readonly<{ kind: 'failed'; failure: Failure | WorkflowActionError; machine: string | null }>;

const invalidOutput = (error: string): Failure => ({
  ok: false,
  errorCode: 'action_invalid_output',
  error,
});

export function useMachineFleetRollout(
  input: Readonly<{ serverId: string; onSettled: () => void }>,
) {
  const { lifetime, run, abort, inFlight } = useScopedActionRun(input.serverId);
  const { confirm, answer, pending } = useInStepActionConfirmation();
  const [state, setState] = React.useState<FleetRollout>({ kind: 'idle' });
  const cancelled = React.useRef(false);

  React.useEffect(
    () => () => {
      abort();
      setState({ kind: 'idle' });
    },
    [input.serverId, lifetime, abort],
  );

  const prepare = React.useCallback(
    async (scope: MachineUpdatesScope, machines: readonly FleetMachine[]) => {
      if (inFlight() || !lifetime || machines.length === 0) return;
      cancelled.current = false;
      const homeId = lifetime.scope.serverId;
      const targets: FleetReviewedTarget[] = [];
      const nothing: string[] = [];
      for (const machine of machines) {
        setState({
          kind: 'preparing',
          scope,
          machine: machine.name,
          approval: null,
        });
        const target = {
          serverId: input.serverId,
          homeId,
          machineId: machine.machineId,
        };
        const result = await run(
          'machines.setup.plan',
          {
            homeId,
            machineId: machine.machineId,
            updates: { scope },
            mode: 'effects',
          },
          (signal, bound) =>
            planMachineUpdates(target, scope, 'effects', {
              expectedAccountId: bound.scope.accountId,
              signal,
            }),
          (approval) =>
            setState({
              kind: 'preparing',
              scope,
              machine: machine.name,
              approval,
            }),
        );
        if (!result || cancelled.current) return;
        if (!result.ok) {
          setState({ kind: 'failed', failure: result, machine: machine.name });
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
          setState({
            kind: 'failed',
            failure: invalidOutput('machines.setup.plan'),
            machine: machine.name,
          });
          return;
        }
        const packages = updates.plan
          ? readMachineUpdatePackages(updates.plan)
          : [];
        if (updates.plan && packages.length > 0)
          targets.push({ machine, scope, plan: updates.plan, packages });
        else nothing.push(machine.name);
      }
      setState({ kind: 'review', scope, targets, nothing });
    },
    [inFlight, input.serverId, lifetime, run],
  );

  const start = React.useCallback(
    async (
      options: Readonly<{
        others: readonly FleetMachine[];
        failurePolicy: WorkflowFailurePolicy;
        restartIfNeeded: boolean;
        later: boolean;
        title: string;
      }>,
    ) => {
      // The Machine's carried review is on this step: the same press answers it.
      if (pending) {
        answer(true);
        return;
      }
      if (
        inFlight() ||
        state.kind !== 'review' ||
        state.targets.length === 0 ||
        !lifetime
      )
        return;
      const { scope, targets } = state;
      const rollout = buildFleetRolloutInput({
        homeId: lifetime.scope.serverId,
        targets,
        others: options.others,
        failurePolicy: options.failurePolicy,
        restartIfNeeded: options.restartIfNeeded,
      });
      setState({
        kind: 'starting',
        scope,
        targets,
        approval: null,
        later: options.later,
      });
      if (options.later) {
        // Later is a saved Workflow carrying this reviewed input; its page sets when it runs.
        try {
          const created = await createWorkflowDefinition({
            definitionId: randomUUID(),
            accountLifetime: lifetime,
            definition: createScheduledMachineUpdatesRolloutWorkflowV1(rollout),
            metadata: { title: options.title },
          });
          setState({ kind: 'idle' });
          return created.definitionId;
        } catch (error) {
          setState({
            kind: 'failed',
            machine: null,
            failure: error instanceof WorkflowActionError ? error : {
              ok: false,
              errorCode: 'workflow_definition_create_failed',
              error: error instanceof Error ? error.message : String(error),
            },
          });
          return null;
        }
      }
      const result = await run(
        'machines.setup.updates.rollout',
        rollout,
        (signal, bound) =>
          rolloutMachineUpdates(
            input.serverId,
            rollout,
            { expectedAccountId: bound.scope.accountId, signal },
            confirm,
          ),
        (approval) =>
          setState({
            kind: 'starting',
            scope,
            targets,
            approval,
            later: false,
          }),
      );
      if (!result) return null;
      if (!result.ok) {
        setState({ kind: 'failed', failure: result, machine: null });
        return null;
      }
      const parsed = ManagedMachineActionOutputSchemasV1[
        'machines.setup.updates.rollout'
      ].safeParse(result.result);
      setState(
        parsed.success
          ? {
              kind: 'rolling',
              operationId: parsed.data.operationId,
              machineId: rollout.machineId,
              count: targets.length,
            }
          : {
              kind: 'failed',
              failure: invalidOutput('machines.setup.updates.rollout'),
              machine: null,
            },
      );
      return null;
    },
    [answer, confirm, inFlight, input.serverId, lifetime, pending, run, state],
  );

  const operation = useActionOperation({
    serverId: state.kind === 'rolling' ? input.serverId : null,
    operationId: state.kind === 'rolling' ? state.operationId : '',
  }, { machineId: state.kind === 'rolling' ? state.machineId : '', actionId: 'machines.setup.updates.rollout', lifetime });
  const operationState = operation?.snapshot.state ?? null;
  const operationFailure = operation?.snapshot.error;
  const { onSettled } = input;
  React.useEffect(() => {
    if (
      state.kind !== 'rolling' ||
      !operationState ||
      !isActionOperationTerminal(operationState)
    )
      return;
    setState({
      kind: 'settled',
      operationId: state.operationId,
      count: state.count,
      failure: operationFailure,
      state:
        operationState === 'succeeded'
          ? 'succeeded'
          : operationState === 'cancelled'
            ? 'cancelled'
            : 'failed',
    });
    onSettled();
  }, [onSettled, operationFailure, operationState, state]);

  const cancel = React.useCallback(() => {
    cancelled.current = true;
    answer(false);
    abort();
    setState({ kind: 'idle' });
  }, [abort, answer]);

  return {
    rollout: state,
    confirmation: state.kind === 'starting' ? pending : null,
    prepare,
    start,
    cancel,
  };
}
