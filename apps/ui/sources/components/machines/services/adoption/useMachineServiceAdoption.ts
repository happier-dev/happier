import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
  MachineServiceAdoptResultV1Schema,
  type MachineServiceAdoptInputV1,
  type MachineServiceAdoptResultV1,
} from '@happier-dev/protocol/local/services/adoptionV1';

import { useEnvironmentSecretBindingsEditor } from '@/components/projects/deployments/useEnvironmentSecretBindingsEditor';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useScopedActionRun } from '@/components/machines/security/useScopedActionRun';
import { randomUUID } from '@/platform/randomUUID';
import {
  createFrontDoorActionExecute,
  type FrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type Review = Extract<MachineServiceAdoptResultV1, { kind: 'review' }>;
type ApplyInput = Extract<MachineServiceAdoptInputV1, { mode: 'apply' }>;
export type MachineServiceAdoptionChoices = Readonly<{
  destination: ApplyInput['destination'];
  bindings: readonly ApplyInput['bindings'][number][];
}>;

/**
 * Adopting a watched Compose project (P30 H11) as one person-driven flow: a value-free capture of what runs
 * (`mode: review`), then one apply of exactly that reviewed digest. A partial outcome keeps its own words and
 * continues under the same request key, because the Action re-enters a partial operation rather than starting over.
 */
export type MachineServiceAdoption =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'reading'; review: Review | null }>
  | Readonly<{ kind: 'review'; review: Review }>
  | Readonly<{ kind: 'applying'; review: Review; approval: ActionApprovalContinuation | null }>
  | Readonly<{ kind: 'adopted'; review: Review; environmentId: string }>
  | Readonly<{ kind: 'partial'; review: Review; errorCode: string; environmentId: string | null }>
  | Readonly<{ kind: 'failed'; step: 'review' | 'apply'; code: string; review: Review | null }>;

const defaultExecute = createFrontDoorActionExecute();

export function useMachineServiceAdoption(input: Readonly<{
  serverId: string;
  machineId: string;
  service: Readonly<{ serviceId: string; generation: string | null }>;
  /** The Action front door; tests build one over the real executor with only the Machine RPC substituted. */
  execute?: FrontDoorActionExecute;
}>) {
  const execute = input.execute ?? defaultExecute;
  const { lifetime, run, abort, inFlight } = useScopedActionRun(input.serverId);
  const [state, setState] = React.useState<MachineServiceAdoption>({ kind: 'idle' });
  const { serverId, machineId } = input;
  const { serviceId, generation } = input.service;
  // A new reviewed service or Account starts a fresh intent; unchanged retries retain the exact applied input below.
  const requestKey = React.useMemo(() => randomUUID(), [serverId, machineId, serviceId, generation, lifetime?.scope.accountId]);
  const lastApply = React.useRef<ApplyInput | null>(null);
  const [destination, setDestination] = React.useState<ApplyInput['destination'] | null>(null);
  const [bindings, setBindings] = React.useState<ApplyInput['bindings']>([]);
  const bindingsEditor = useEnvironmentSecretBindingsEditor({
    bindings, scopeKey: requestKey,
    readOnly: state.kind === 'applying' || state.kind === 'partial' || state.kind === 'adopted',
    isCurrent: () => lifetime?.isCurrent() === true,
    onChangeBindings: next => setBindings(next.filter(binding => binding.purpose === 'variable')),
  });
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => () => {
    abort();
    lastApply.current = null;
    setDestination(null);
    setBindings([]);
    setState({ kind: 'idle' });
  }, [serverId, machineId, serviceId, generation, lifetime, abort]);

  const invoke = React.useCallback(async (actionInput: MachineServiceAdoptInputV1,
    onApproval: (approval: ActionApprovalContinuation) => void): Promise<ActionExecuteResult | null> =>
    await run('machines.services.adopt', actionInput, (signal, bound) => execute('machines.services.adopt', actionInput, {
      surface: 'ui', serverId, expectedAccountId: bound.scope.accountId, signal,
    }), onApproval), [execute, run, serverId]);

  const review = React.useCallback(async (profiles: readonly string[]) => {
    if (inFlight() || generation === null) return;
    const previous = stateRef.current;
    const kept = 'review' in previous ? previous.review : null;
    setState({ kind: 'reading', review: kept });
    const result = await invoke({ serverId, machineId, serviceId, expectedGeneration: generation, requestKey,
      profiles: [...profiles], mode: 'review' }, () => {});
    if (!result) return;
    const parsed = result.ok ? MachineServiceAdoptResultV1Schema.safeParse(result.result) : null;
    if (parsed?.success && parsed.data.kind === 'review') {
      setState({ kind: 'review', review: parsed.data });
      return;
    }
    setState({ kind: 'failed', step: 'review', review: kept,
      code: result.ok ? 'action_invalid_output' : result.errorCode });
  }, [generation, inFlight, invoke, machineId, requestKey, serverId, serviceId]);

  const send = React.useCallback(async (actionInput: ApplyInput, reviewed: Review) => {
    lastApply.current = actionInput;
    setState({ kind: 'applying', review: reviewed, approval: null });
    const result = await invoke(actionInput, approval => setState({ kind: 'applying', review: reviewed, approval }));
    if (!result) return;
    if (!result.ok) {
      setState({ kind: 'failed', step: 'apply', code: result.errorCode, review: reviewed });
      return;
    }
    const parsed = MachineServiceAdoptResultV1Schema.safeParse(result.result);
    if (!parsed.success || parsed.data.kind === 'review') {
      setState({ kind: 'failed', step: 'apply', code: 'action_invalid_output', review: reviewed });
      return;
    }
    if (parsed.data.kind === 'adopted') {
      setState({ kind: 'adopted', review: reviewed, environmentId: parsed.data.environmentId });
      return;
    }
    setState({ kind: 'partial', review: reviewed, errorCode: parsed.data.errorCode,
      environmentId: parsed.data.environmentId ?? null });
  }, [invoke]);

  const apply = React.useCallback(async (choices?: MachineServiceAdoptionChoices) => {
    const current = stateRef.current;
    if (inFlight() || generation === null || (current.kind !== 'review' && current.kind !== 'failed') || !current.review) return;
    const selected = choices ?? (destination ? { destination, bindings } : null);
    if (!selected) return;
    const reviewed = current.review;
    const previous = lastApply.current;
    let actionInput: ApplyInput = { serverId, machineId, serviceId, expectedGeneration: generation,
      requestKey: previous?.requestKey ?? requestKey, profiles: [...reviewed.profiles],
      mode: 'apply', reviewedDigest: reviewed.reviewedDigest, destination: selected.destination,
      bindingsConfirmed: true, bindings: [...selected.bindings] };
    if (previous && !sameStrictJsonValue(previous, actionInput, { omitUndefinedObjectMembers: true })) {
      actionInput = { ...actionInput, requestKey: randomUUID() };
    }
    await send(actionInput, reviewed);
  }, [bindings, destination, generation, inFlight, machineId, requestKey, send, serverId, serviceId]);

  /** Retry the identical refused or partial request; the Action retains any steps it already completed. */
  const retry = React.useCallback(async () => {
    const current = stateRef.current;
    if (inFlight() || !lastApply.current || (current.kind !== 'partial' && current.kind !== 'failed')
      || !current.review || current.kind === 'failed' && current.step !== 'apply') return;
    await send(lastApply.current, current.review);
  }, [inFlight, send]);

  const clearError = React.useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== 'failed') return;
    setState(current.review ? { kind: 'review', review: current.review } : { kind: 'idle' });
  }, []);

  return { state, review, apply, retry, abort, clearError, lifetime, destination, setDestination, bindings, bindingsEditor };
}
