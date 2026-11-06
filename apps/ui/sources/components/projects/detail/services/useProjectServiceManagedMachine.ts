import * as React from 'react';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { runManagedMachineCreation, type ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createFrontDoorActionExecute, type FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { managedMachineCreationIntent, type ManagedMachineSelectionDraft, type ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { randomUUID } from '@/platform/randomUUID';

type ExactChoice = Extract<ProjectExecutionChoiceV1, { kind: 'workers' }>;
type Continuation = {
  draft: ManagedMachineSelectionDraft | null;
  acquisition: ManagedMachineAcquisitionDraft | null;
  cancellation: AbortController | null;
  resolve: ((choice: ExactChoice | null) => void) | null;
  inFlight: boolean;
  consumed: boolean;
};

/** A Service intent joins the same acquisition/enrollment owner as finite Run; it never starts a Session. */
export function useProjectServiceManagedMachine(input: Readonly<{
  scopeKey: string;
  serverId: string;
  binding: ServerCredentialAccountScopeBinding | null;
  runtimeActionExecute?: FrontDoorRuntimeActionExecute;
}>) {
  const session = React.useMemo<Continuation>(() => ({ draft: null, acquisition: null, cancellation: null,
    resolve: null, inFlight: false, consumed: false }), [input.scopeKey, input.binding]);
  const active = React.useRef<Continuation | null>(session);
  active.current = session;
  const [state, setState] = React.useState<Readonly<{ session: Continuation; progress: ManagedMachineCreationProgress }> | null>(null);
  const [selection, setSelection] = React.useState<Readonly<{ session: Continuation; draft: ManagedMachineSelectionDraft | null }> | null>(null);
  const draft = selection?.session === session ? selection.draft : null;
  const progress = state?.session === session ? state.progress : null;
  const current = () => active.current === session && input.binding?.isCurrent() === true && !session.cancellation?.signal.aborted;
  const execute = React.useMemo(() => input.runtimeActionExecute
    ? createFrontDoorActionExecute({ execute: async (actionId, value, context) => {
      const result = await input.runtimeActionExecute!({ actionId, input: value, context: context ?? {} });
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data : { ok: true, result };
    } }) : createFrontDoorActionExecute(), [input.runtimeActionExecute]);
  const approval = useActionApprovalContinuation({ scopeKey: input.scopeKey, serverId: input.serverId,
    onExecuted: () => {} });
  const approvalRef = React.useRef(approval.requestApproval);
  approvalRef.current = approval.requestApproval;
  const cancel = React.useCallback(() => {
    session.cancellation?.abort();
    session.resolve?.(null);
    session.resolve = null;
    if (active.current === session) setState({ session, progress: { kind: 'failed', code: 'continuation_retired',
      ...(session.acquisition?.managedId ? { managedId: session.acquisition.managedId } : {}) } });
  }, [session]);
  React.useLayoutEffect(() => {
    active.current = session;
    const retirement = input.binding?.onRetire(cancel);
    return () => { retirement?.dispose(); session.cancellation?.abort(); session.resolve?.(null); session.resolve = null;
      if (active.current === session) active.current = null; };
  }, [cancel, input.binding, session]);
  const select = React.useCallback((value: ManagedMachineSelectionDraft | null) => {
    cancel();
    if (!value || !session.draft || !sameStrictJsonValue(managedMachineCreationIntent(value), managedMachineCreationIntent(session.draft))) {
      session.acquisition = value ? { requestId: randomUUID(), selection: value.selection } : null;
      session.consumed = false;
    }
    session.draft = value;
    setSelection({ session, draft: value });
    setState(null);
  }, [cancel, session]);
  const resume = async () => {
    if (!session.resolve || session.inFlight || !session.draft || !session.acquisition || !session.cancellation || !current() || !input.binding) return;
    const cancellation = session.cancellation;
    const invocationCurrent = () => current() && session.cancellation === cancellation && !cancellation.signal.aborted;
    session.inFlight = true;
    try {
      const acquired = await runManagedMachineCreation({ draft: managedMachineCreationIntent(session.draft)!,
        acquisition: session.acquisition, scope: input.binding.scope, signal: cancellation.signal,
        isCurrent: invocationCurrent, executeAction: execute, onApprovalPending: registration => approvalRef.current(registration),
        onAcquisitionChange: value => { session.acquisition = value; },
        onProgress: value => { if (invocationCurrent()) setState({ session, progress: value }); },
      });
      if (!invocationCurrent()) return;
      if (acquired.kind === 'pending') return;
      if (acquired.kind === 'enrolled') {
        // An uncertain native Start must be inspected, never replayed by another enrollment event.
        session.consumed = true;
        session.resolve?.({ kind: 'workers', destination: { kind: 'machine', machineId: acquired.machine.enrolledMachineId } });
      } else session.resolve?.(null);
      session.resolve = null;
    } catch (error) {
      if (!invocationCurrent()) return;
      setState({ session, progress: { kind: 'failed', code: error instanceof Error ? error.message : 'request_failed',
        ...(session.acquisition?.managedId ? { managedId: session.acquisition.managedId } : {}) } });
      session.resolve?.(null);
      session.resolve = null;
    } finally {
      session.inFlight = false;
      // Inventory may already have arrived while the owner's read was settling.
      if (invocationCurrent() && session.resolve) setState(previous => previous?.session === session ? { ...previous } : previous);
    }
  };
  const resumeRef = React.useRef(resume);
  resumeRef.current = resume;
  const acquire = React.useCallback((signal?: AbortSignal): Promise<ExactChoice | null> => {
    if (active.current !== session || !session.draft || session.resolve || session.inFlight || session.consumed || !input.binding?.isCurrent()
      || session.draft.selection.homeId !== getServerProfileById(input.serverId)?.serverIdentityId || signal?.aborted) return Promise.resolve(null);
    session.cancellation = new AbortController();
    return new Promise<ExactChoice | null>(resolve => {
      const dispose = () => signal?.removeEventListener('abort', cancel);
      session.resolve = value => { dispose(); resolve(value); };
      signal?.addEventListener('abort', cancel, { once: true });
      void resumeRef.current();
    });
  }, [cancel, input.binding, input.serverId, session]);
  const inventoryIds = React.useMemo(() => session.resolve && session.acquisition?.managedId ? [input.serverId] : [],
    [input.serverId, session, state]);
  const inventory = useManagedMachineInventory(inventoryIds, undefined, execute);
  const enrollment = inventory.entries[resolveServerProfileScopeIdForIdentifier(input.serverId)];
  const resumedEnrollment = React.useRef<Readonly<{ session: Continuation; entry: typeof enrollment }> | null>(null);
  React.useEffect(() => {
    if (!session.resolve || !progress || (progress.kind !== 'acquiring' && progress.kind !== 'enrollment_pending' && progress.kind !== 'setup_pending')
      || enrollment?.status !== 'ready') return;
    if (!session.inFlight && !(resumedEnrollment.current?.session === session && resumedEnrollment.current.entry === enrollment)
      && enrollment.machines.some(machine => machine.id === session.acquisition?.managedId && machine.enrolledMachineId
      && machine.creationState === 'active' && machine.environmentSetup?.state !== 'pending' && machine.environmentSetup?.state !== 'running')) {
      resumedEnrollment.current = { session, entry: enrollment };
      void resumeRef.current();
    }
  }, [enrollment, progress, session, state]);
  const busy = session.resolve !== null;
  return React.useMemo(() => ({ draft, progress, select, acquire, cancel, busy }), [draft, progress, select, acquire, cancel, busy]);
}
