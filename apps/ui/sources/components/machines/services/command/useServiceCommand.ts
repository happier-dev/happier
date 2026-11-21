import * as React from 'react';
import {
  MachineServiceExecResultV1Schema,
  type MachineServiceExecInputV1,
} from '@happier-dev/protocol/actions/specs/machine/services';
import { tokenizeShellWords } from '@happier-dev/protocol/tools/shellWords';
import type { WorkflowMachineCommandOutputV1 } from '@happier-dev/protocol/workflows/commandOutputV1';

import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useScopedActionRun } from '@/components/machines/security/useScopedActionRun';
import {
  createFrontDoorActionExecute,
  type FrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * The running service at the generation the page shows. A prepared Deployment candidate is host-only: a public
 * invocation can't mint its admitted parent, so this composition never offers it.
 */
export type ServiceCommandTarget = Extract<MachineServiceExecInputV1['target'], { kind: 'current' }>;

export type ServiceCommandFinished = Readonly<{
  kind: 'finished';
  output: WorkflowMachineCommandOutputV1;
  durationMs: number;
}>;

export type ServiceCommandState =
  | Readonly<{ kind: 'idle' }>
  /** `previous` keeps the last output on screen while the next run goes, so the sheet never empties under the person. */
  | Readonly<{
      kind: 'running';
      approval: ActionApprovalContinuation | null;
      previous: ServiceCommandFinished | null;
    }>
  | ServiceCommandFinished
  /** The command was dispatched but its exit never came back: it may have run, so it never reads as done. */
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'failed'; code: string; failure?: ActionExecuteFailure }>;

const defaultExecute = createFrontDoorActionExecute();

/**
 * "Run a command" (P30 §463, shared by the Machine service page and the Environment service row): one
 * `machines.services.exec` per press, through the Action front door. The person's own press is the approval
 * (`confirmed`); an agent asking the same Action gets the transcript approval card instead. The command is literal
 * words (no shell): `null` from {@link parseServiceCommand} means it uses shell syntax the Action can't run.
 */
export function useServiceCommand(
  input: Readonly<{
    serverId: string;
    machineId: string;
    target: ServiceCommandTarget;
    /** The Action front door; tests build one over the real executor with only the Machine RPC substituted. */
    execute?: FrontDoorActionExecute;
  }>,
) {
  const execute = input.execute ?? defaultExecute;
  const {
    run: runScoped,
    abort,
    inFlight,
  } = useScopedActionRun(input.serverId);
  const [state, setState] = React.useState<ServiceCommandState>({
    kind: 'idle',
  });
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const { serverId, machineId, target } = input;
  const targetKey = JSON.stringify(target);

  // A different service, generation or Account is a different command: nothing from the last one carries over.
  React.useEffect(
    () => () => {
      abort();
      setState({ kind: 'idle' });
    },
    [serverId, machineId, targetKey, abort],
  );

  const run = React.useCallback(
    async (argv: readonly string[]) => {
      if (inFlight() || argv.length === 0) return;
      const actionInput: MachineServiceExecInputV1 = {
        serverId,
        machineId,
        argv: [...argv],
        target,
        mode: 'exec',
      };
      const startedAt = Date.now();
      const previous = stateRef.current.kind === 'finished' ? stateRef.current : null;
      setState({ kind: 'running', approval: null, previous });
      const result = await runScoped(
        'machines.services.exec',
        actionInput,
        (signal, bound) =>
          execute.confirmed('machines.services.exec', actionInput, {
            surface: 'ui',
            serverId,
            expectedAccountId: bound.scope.accountId,
            signal,
          }),
        (approval) => setState({ kind: 'running', approval, previous }),
      );
      if (!result) return;
      if (!result.ok) {
        setState(
          result.errorCode === 'action_outcome_unknown'
            ? { kind: 'unknown' }
            : { kind: 'failed', code: result.errorCode, failure: result },
        );
        return;
      }
      const parsed = MachineServiceExecResultV1Schema.safeParse(result.result);
      if (!parsed.success) {
        setState({ kind: 'failed', code: 'action_invalid_output' });
        return;
      }
      if ('kind' in parsed.data) {
        setState({ kind: 'unknown' });
        return;
      }
      setState({
        kind: 'finished',
        output: parsed.data,
        durationMs: Date.now() - startedAt,
      });
      // `target` is read through its key: callers pass a fresh object for the same service each render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [execute, inFlight, machineId, runScoped, serverId, targetKey],
  );

  return { state, run };
}

/** The literal words the Action runs, or null when the text needs a shell (pipes, variables, wildcards). */
export function parseServiceCommand(text: string): readonly string[] | null {
  const words = tokenizeShellWords(text.trim());
  return words && words.length > 0 && words[0] !== '' ? words : null;
}
