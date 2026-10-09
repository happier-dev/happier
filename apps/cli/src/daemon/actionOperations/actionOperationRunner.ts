import { randomUUID } from 'node:crypto';

import type {
  ActionOperationCancelV1Response,
  ActionOperationFailureV1,
  ActionExecuteResult,
} from '@happier-dev/protocol/actions';
import { ActionOperationDomainRefV1Schema, ActionOperationFailureV1Schema, ActionOperationObservationV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { ProjectSetupConsentFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { parseActionOperationProgressUpdate } from './actionOperationProgress';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { ActionOperationStore } from './actionOperationStore';
import type {
  ActionOperationOwnerUpdate,
  ActionOperationProgressUpdate,
  ActionOperationQueryScope,
  ActionOperationScope,
  ResolvedTrackedAction,
  ActionOperationReviewContinuation,
} from './actionOperationTypes';

type ActiveInvocation = Readonly<{
  actionId: string;
  scope: ActionOperationScope;
  controller: AbortController;
  cancellation: 'unsupported' | 'supported';
  result: Promise<ActionExecuteResult>;
  response: Promise<ActionExecuteResult>;
  notifyCancellationRequested: () => void;
  resumeSetupReview: () => void;
  refreshSetupReview: () => Promise<void>;
}>;

function terminalResult(snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): ActionExecuteResult | null {
  if (snapshot.state === 'succeeded') return { ok: true, result: snapshot.result };
  if (snapshot.state === 'failed') {
    return {
      ok: false,
      errorCode: snapshot.error?.errorCode ?? 'action_operation_failed',
      error: snapshot.error?.error ?? 'action_operation_failed',
      ...(snapshot.error?.details ? { details: snapshot.error.details } : {}),
    };
  }
  if (snapshot.state === 'cancelled') return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  return null;
}

function createCancellationRequestError(): Error {
  const error = new Error('Action operation cancellation requested');
  error.name = 'AbortError';
  return error;
}

function projectThrownFailure(error: unknown): ActionOperationFailureV1 {
  const code = error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && error.code.trim()
    ? error.code.trim()
    : 'action_operation_failed';
  return {
    errorCode: code,
    error: error instanceof Error && error.message.trim()
      ? error.message
      : 'action_operation_failed',
  };
}

function isRecoverableIndeterminateHandoff(
  actionId: string,
  result: ActionExecuteResult,
): boolean {
  return actionId === 'session.handoff'
    && !result.ok
    && result.errorCode === 'indeterminate';
}

function isFiniteProjectCommand(actionId: string): boolean {
  return actionId === 'projects.script.run' || actionId === 'projects.compute.exec' || actionId === 'projects.prepare';
}

function isUnconfirmedOwnedOutcome(actionId: string, result: ActionExecuteResult): boolean {
  if (actionId === 'daemon.filesystem.upload' || actionId === 'daemon.filesystem.download' || actionId === 'daemon.filesystem.copy') {
    return !result.ok && result.errorCode === 'indeterminate';
  }
  return (isFiniteProjectCommand(actionId) || actionId === 'projects.service.relocate' || actionId === 'machines.environment.apply') && !result.ok
    && (result.errorCode === 'outcome_uncertain' || result.errorCode === 'stop_unconfirmed');
}

export function createActionOperationRunner(deps: Readonly<{
  store: ActionOperationStore;
  resolveAction: (actionId: string) => ResolvedTrackedAction | null;
  generateOperationId?: () => string;
}>) {
  const generateOperationId = deps.generateOperationId ?? randomUUID;
  const active = new Map<string, ActiveInvocation>();
  let finiteRetirement: Promise<void> | undefined;

  const observe = async (request: Readonly<{
    actionId: string;
    action?: ResolvedTrackedAction;
    requestId?: string;
    input?: unknown;
    domainRef?: import('@happier-dev/protocol/actions').ActionOperationDomainRefV1;
    scope: ActionOperationScope;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    cancellation?: 'unsupported' | 'supported';
    execute: (context: Readonly<{
      actionRequestId?: string;
      resumeActionRequest?: true;
      signal: AbortSignal;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      updateProgress: (update: ActionOperationProgressUpdate) => void;
      publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
      operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
      onCancellationRequested: (listener: () => void) => () => void;
      operationReview: ActionOperationReviewContinuation;
    }>) => Promise<ActionExecuteResult>;
  }>): Promise<ActionExecuteResult> => {
    const action = request.action ?? deps.resolveAction(request.actionId);
    if (!action?.operation) {
      return await request.execute({
        signal: new AbortController().signal,
        updateProgress: () => undefined,
        publishOwnerUpdate: () => undefined,
        onCancellationRequested: () => () => undefined,
        operationReview: { waitForResume: async () => { throw new Error('action_operation_unavailable'); } },
      });
    }
    const existing = request.requestId
      ? deps.store.findByRequestIdentity(request.scope, request.actionId, request.requestId)
      : null;
    const inputIdentity = createCanonicalJsonSigningInput(request.input === undefined ? null : request.input);
    if (existing && !deps.store.hasMatchingInputIdentity(existing.operationId, inputIdentity)) {
      return { ok: false, errorCode: 'action_request_input_conflict', error: 'action_request_input_conflict' };
    }
    const invoke = async (
      operationId: string,
      cancellation: 'unsupported' | 'supported',
      resumeActionRequest = false,
    ): Promise<ActionExecuteResult> => {
      const controller = new AbortController();
      let resumeSetupReview = () => {};
      let refreshSetupReview = async () => {};
      const operationReview: ActionOperationReviewContinuation = {
        waitForResume: async (details, producer) => {
          if (!isFiniteProjectCommand(action.actionId)) throw new Error('action_operation_unavailable');
          const parsed = ProjectSetupConsentFailureDetailsV1Schema.parse(details);
          if (controller.signal.aborted) throw controller.signal.reason ?? createCancellationRequestError();
          await new Promise<void>((resolve, reject) => {
            let current = true;
            let refreshing: Promise<void> | undefined;
            const cleanup = () => {
              current = false;
              controller.signal.removeEventListener('abort', abort);
              resumeSetupReview = () => {};
              refreshSetupReview = async () => {};
              deps.store.updateSetupReview(operationId, undefined);
            };
            const abort = () => { cleanup(); reject(controller.signal.reason ?? createCancellationRequestError()); };
            const resume = () => { if (current) { cleanup(); resolve(); } };
            resumeSetupReview = () => {
              // An exact-request rejoin must not run alongside its producer's
              // current source/target review inside the retained reservation.
              if (refreshing) void refreshing.then(resume, () => undefined);
              else resume();
            };
            refreshSetupReview = () => {
              if (!producer || !current) return Promise.resolve();
              if (!refreshing) {
                refreshing = (async () => {
                  const reviewed = await producer.review();
                  if (!current || controller.signal.aborted) return;
                  if (reviewed) deps.store.updateSetupReview(operationId, ProjectSetupConsentFailureDetailsV1Schema.parse(reviewed));
                  else resume();
                })().catch(error => {
                  if (current) {
                    cleanup();
                    reject(error);
                  }
                }).finally(() => { refreshing = undefined; });
              }
              return refreshing;
            };
            controller.signal.addEventListener('abort', abort, { once: true });
            deps.store.updateSetupReview(operationId, parsed);
          });
        },
      };
      const cancellationListeners = new Set<() => void>();
      const onCancellationRequested = (listener: () => void): (() => void) => {
        cancellationListeners.add(listener);
        return () => { cancellationListeners.delete(listener); };
      };
      let accept!: (result: ActionExecuteResult) => void;
      const acceptance = new Promise<ActionExecuteResult>((resolve) => { accept = resolve; });
      const acceptFinite = (): void => {
        const operation = deps.store.get(request.scope, operationId);
        if (operation?.domainRef?.kind === 'projectCommand') accept({ ok: true, result: { operation } });
      };
      const updateProgress = (update: ActionOperationProgressUpdate): void => {
        const progress = parseActionOperationProgressUpdate(update);
        if (progress) {
          deps.store.updateProgress(operationId, progress);
          if (action.actionId === 'projects.service.relocate' && progress.phase === 'stopping') {
            const operation = deps.store.get(request.scope, operationId);
            if (operation) accept({ ok: true, result: { status: 'accepted', operation } });
          }
        }
      };
      const publishOwnerUpdate = (update: ActionOperationOwnerUpdate): void => {
        if (update.domainRef) {
          const domainRef = ActionOperationDomainRefV1Schema.safeParse(update.domainRef);
          if (domainRef.success) deps.store.updateDomainRef(operationId, domainRef.data);
          if (domainRef.success && domainRef.data.kind === 'projectCommand' && isFiniteProjectCommand(action.actionId)) {
            acceptFinite();
          }
        }
        if (update.state === 'running') deps.store.markRunning(operationId);
        if (update.observation === null) deps.store.updateObservation(operationId, null);
        else if (update.observation) {
          const observation = ActionOperationObservationV1Schema.safeParse(update.observation);
          if (observation.success) deps.store.updateObservation(operationId, observation.data);
        }
        if (update.progress) updateProgress(update.progress);
      };
      const result = Promise.resolve().then(async (): Promise<ActionExecuteResult> => {
        try {
          const attribution = deps.store.readRequesterWorkAttribution(operationId);
          const executionResult = await request.execute({
            ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
            actionRequestId: request.requestId ?? operationId,
            ...(resumeActionRequest ? { resumeActionRequest: true as const } : {}),
            signal: controller.signal,
            updateProgress,
            publishOwnerUpdate,
            onCancellationRequested,
            operationReview,
            operationAcceptance: { operationId, actionId: action.actionId, accept: (result) => {
              if (isFiniteProjectCommand(action.actionId)) acceptFinite();
              else accept({ ok: true, result });
            } },
          });
          if (isRecoverableIndeterminateHandoff(action.actionId, executionResult)) {
            return executionResult;
          }
          if (action.actionId === 'session.spawn_new' && executionResult.ok) {
            const settlement = SessionSpawnNewResultV1Schema.safeParse(executionResult.result);
            if (settlement.success && settlement.data.type === 'pending') {
              deps.store.updateObservation(operationId, { kind: 'outcome_uncertain', code: 'outcome_uncertain' });
              return executionResult;
            }
          }
          if (isUnconfirmedOwnedOutcome(action.actionId, executionResult) && !executionResult.ok) {
            deps.store.updateObservation(operationId, { kind: executionResult.errorCode === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: executionResult.errorCode });
            return executionResult;
          }
          if (action.actionId === 'machines.managed.acquire' && executionResult.ok
            && deps.store.get(request.scope, operationId)?.observation?.kind === 'outcome_uncertain') {
            // Compute acceptance is not confirmation that the ordinary guest
            // Session has started. Its actual owner retains this uncertainty.
            return executionResult;
          }
          if (!executionResult.ok && executionResult.errorCode === 'cancelled') {
            deps.store.cancel(operationId);
          } else if (executionResult.ok) {
            deps.store.succeed(operationId, executionResult.result);
          } else {
            const failure = { errorCode: executionResult.errorCode, error: executionResult.error };
            // Only named finite Project consent/refusal producers carry public
            // redacted facts. Arbitrary executor details remain private.
            const reviewedFailure = isFiniteProjectCommand(action.actionId)
              ? ActionOperationFailureV1Schema.safeParse({ ...failure, details: executionResult.details }) : null;
            deps.store.fail(operationId, reviewedFailure?.success ? reviewedFailure.data : failure);
          }
          return executionResult;
        } catch (error) {
          const projected = projectThrownFailure(error);
          const acceptedFinite = isFiniteProjectCommand(action.actionId)
            && deps.store.get(request.scope, operationId)?.domainRef?.kind === 'projectCommand';
          if (acceptedFinite) {
            deps.store.updateObservation(operationId, { kind: controller.signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: projected.errorCode });
            throw error;
          }
          if (isUnconfirmedOwnedOutcome(action.actionId, { ok: false, ...projected })) {
            deps.store.updateObservation(operationId, { kind: projected.errorCode === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
              code: projected.errorCode });
          }
          if (!isUnconfirmedOwnedOutcome(action.actionId, { ok: false, ...projected })
            && (action.actionId !== 'session.handoff' || projected.errorCode !== 'indeterminate')) {
            if (projected.errorCode === 'cancelled') deps.store.cancel(operationId);
            else deps.store.fail(operationId, projected);
          }
          throw error;
        } finally {
          active.delete(operationId);
        }
      });
      const response = Promise.race([result, acceptance]);
      active.set(operationId, { actionId: action.actionId, scope: request.scope, controller, cancellation, result, response,
        resumeSetupReview: () => resumeSetupReview(),
        refreshSetupReview: () => refreshSetupReview(),
        notifyCancellationRequested: () => { for (const listener of cancellationListeners) listener(); } });
      return await response;
    };
    if (existing) {
      const invocation = active.get(existing.operationId);
      if (invocation) {
        if (existing.setupReview) invocation.resumeSetupReview();
        return await invocation.response;
      }
      if (isFiniteProjectCommand(action.actionId) && existing.domainRef?.kind === 'projectCommand') {
        return { ok: true, result: { operation: existing } };
      }
      const settled = terminalResult(existing);
      if (settled) return settled;
      if (existing.state === 'running' && action.actionId === 'session.handoff') {
        return await invoke(existing.operationId, existing.cancellation);
      }
      if (existing.state === 'running' && action.actionId === 'session.spawn_new') {
        // Re-entry observes the already-owned creation nonce; it never submits
        // another Session after an unconfirmed native outcome.
        return await invoke(existing.operationId, existing.cancellation, true);
      }
      if (existing.state === 'running' && action.actionId === 'machines.managed.acquire'
        && existing.observation?.kind === 'outcome_uncertain') {
        // The exact original requester/input retains the continuation. The
        // enrolled acquisition owner observes its row without buying again.
        return await invoke(existing.operationId, existing.cancellation);
      }
      return { ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
    }
    // Final retirement closes only new finite admission. Exact request replay
    // above still observes the original retained invocation and its Stop owner.
    if (finiteRetirement && isFiniteProjectCommand(action.actionId)) {
      return { ok: false, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' };
    }
    const operationId = generateOperationId();
    const cancellation = request.cancellation ?? 'unsupported';
    deps.store.create({
      operationId,
      actionId: action.actionId,
      scope: request.scope,
      ...(request.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: request.requesterWorkAttributionV1 } : {}),
      title: action.title,
      cancellation,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.domainRef ? { domainRef: request.domainRef } : {}),
      inputIdentity,
    });
    if (!isFiniteProjectCommand(action.actionId)) deps.store.markRunning(operationId);
    return await invoke(operationId, cancellation);
  };

  const cancel = (scope: ActionOperationQueryScope, operationId: string): ActionOperationCancelV1Response => {
    const snapshot = deps.store.get(scope, operationId);
    if (!snapshot) return { kind: 'not_found' };
    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      return { kind: 'already_settled' };
    }
    const invocation = active.get(operationId);
    if (!invocation || invocation.cancellation === 'unsupported') return { kind: 'unsupported' };
    invocation.controller.abort(createCancellationRequestError());
    invocation.notifyCancellationRequested();
    return { kind: 'requested' };
  };

  const waitForTerminal = async (scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
    requireSettlement = false, includeSetupReview = false) => {
    const snapshot = deps.store.get(scope, operationId);
    if (!snapshot || terminalResult(snapshot) || !requireSettlement && snapshot.observation || includeSetupReview && snapshot.setupReview) return snapshot;
    const invocation = active.get(operationId);
    if (!invocation && !requireSettlement) return snapshot;
    // Cancelling observation is not a request to stop the admitted command.
    if (signal?.aborted) throw signal.reason ?? createCancellationRequestError();
    let onAbort: (() => void) | undefined;
    let unsubscribe = () => {};
    try {
      const completion = new Promise<typeof snapshot>(resolve => {
          const inspect = () => {
            const current = deps.store.get(scope, operationId);
            if (current && (terminalResult(current) || !requireSettlement && current.observation || includeSetupReview && current.setupReview)) resolve(current);
          };
          unsubscribe = deps.store.subscribe(inspect);
          inspect();
          if (!requireSettlement) void invocation!.result.catch(() => undefined).then(() => resolve(deps.store.get(scope, operationId)));
        });
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason ?? createCancellationRequestError());
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([completion, aborted]);
    } finally {
      unsubscribe();
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };

  return Object.freeze({
    observe,
    cancel,
    async refreshSetupReview(scope: ActionOperationQueryScope, operationId: string): Promise<void> {
      if (!deps.store.get(scope, operationId)?.setupReview) return;
      await active.get(operationId)?.refreshSetupReview();
    },
    /** Final ingress is already closed; every registration shares this one Stop pass and settlement wait. */
    retireProjectFiniteOperations(): Promise<void> {
      if (!finiteRetirement) {
        const captured = [...active.entries()].filter(([, invocation]) => isFiniteProjectCommand(invocation.actionId));
        const settlement = captured.map(([operationId, invocation]) => waitForTerminal(invocation.scope, operationId, undefined, true));
        finiteRetirement = Promise.all(settlement).then(() => undefined);
        for (const [operationId, invocation] of captured) cancel(invocation.scope, operationId);
      }
      return finiteRetirement;
    },
    /** Mounted package scripts wait for their real script attachment, never an earlier setup PTY. */
    async waitForProjectTerminalAttachment(scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal) {
      if (signal?.aborted) throw signal.reason ?? createCancellationRequestError();
      return await new Promise<import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null>((resolve, reject) => {
        let unsubscribe = () => {};
        const cleanup = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(signal?.reason ?? createCancellationRequestError()); };
        const observeSnapshot = () => {
          const snapshot = deps.store.get(scope, operationId);
          if (!snapshot || terminalResult(snapshot) || snapshot.observation
            || (snapshot.domainRef?.kind === 'projectCommand' && snapshot.domainRef.purpose === 'script' && snapshot.domainRef.terminalId)
            || !active.has(operationId)) {
            cleanup();
            resolve(snapshot);
          }
        };
        unsubscribe = deps.store.subscribe(observeSnapshot);
        signal?.addEventListener('abort', abort, { once: true });
        observeSnapshot();
      });
    },
    /** Internal consequence of an authenticated last-grant loss, not public revoked-user ingress. */
    async cancelForAccessLoss(
      scope: Pick<ActionOperationQueryScope, 'accountId' | 'machineId'>,
      verifyCurrentMachineAdmission?: () => Promise<boolean>,
      requester?: RequesterWorkAttributionV1,
    ): Promise<readonly Readonly<{
      operationId: string; result: ActionOperationCancelV1Response | Readonly<{ kind: 'admission_not_current' }>;
    }>[]> {
      const captured = deps.store.list({ accountId: scope.accountId, machineId: scope.machineId,
        states: ['accepted', 'running'] }).items.map(snapshot => ({ snapshot, invocation: active.get(snapshot.operationId) }));
      const results: Array<Readonly<{ operationId: string;
        result: ActionOperationCancelV1Response | Readonly<{ kind: 'admission_not_current' }> }>> = [];
      for (const witness of captured) {
        if (requester) {
          const attribution = deps.store.readRequesterWorkAttribution(witness.snapshot.operationId);
          if (!attribution) {
            results.push({ operationId: witness.snapshot.operationId, result: { kind: 'admission_not_current' } });
            continue;
          }
          if (attribution.serverId !== requester.serverId || attribution.accountId !== requester.accountId
            || attribution.machineId !== requester.machineId || attribution.installationId !== requester.installationId) continue;
        }
        let current = true;
        try { if (verifyCurrentMachineAdmission) current = await verifyCurrentMachineAdmission(); }
        catch { current = false; }
        const snapshot = deps.store.get(scope, witness.snapshot.operationId);
        // Never cancel a replacement invocation selected while a Home read was pending.
        const sameInvocation = active.get(witness.snapshot.operationId) === witness.invocation;
        results.push({ operationId: witness.snapshot.operationId, result: !current || !sameInvocation && snapshot && !terminalResult(snapshot)
          ? { kind: 'admission_not_current' }
          : cancel(witness.snapshot.scope, witness.snapshot.operationId) });
      }
      return results;
    },
    async waitForTerminal(scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
      options?: Readonly<{ includeSetupReview?: true }>) {
      return await waitForTerminal(scope, operationId, signal, false, options?.includeSetupReview === true);
    },
  });
}

export type ActionOperationRunner = ReturnType<typeof createActionOperationRunner>;
