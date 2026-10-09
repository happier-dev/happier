import { BROWSER_AUTOMATION_NOT_IMPLEMENTED_ACTION_KINDS } from '@happier-dev/protocol/browser/automation/notImplemented';
import { BrowserActiveTargetV1Schema } from '@happier-dev/protocol/browser/events/activeTarget';
import type { BrowserActiveTargetV1, BrowserCommandDispatchResultV1, BrowserEventV1, BrowserAutomationActionKindV1, BrowserAutomationActionRequestV1, BrowserAutomationActionResultV1, BrowserAutomationControllerKindV1, BrowserAutomationControllerStateV1, BrowserAutomationErrorCodeV1, BrowserAutomationRequesterKindV1, BrowserAutomationRequesterRefV1, BrowserAutomationTimelineEntryV1, BrowserAutomationTimelineV1 } from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BrowserAutomationActionRequestV1Schema, BrowserAutomationActionResultV1Schema, BrowserAutomationTimelineEntryV1Schema, BrowserAutomationTimelineV1Schema, isBrowserAutomationMutatingActionKind } from '@happier-dev/protocol/browser/automation/v1';

import { executeBrowserAutomationAction } from './actions';
import type { BrowserAutomationAdapter, BrowserConfidentialFillPreparation } from './adapters/types';
import type { BrowserAutomationSecretFillRequestV1 } from '@happier-dev/protocol/browser/automation/v1';
import { SecretFillSettlementV1Schema } from '@happier-dev/protocol/computer/v1';
import type { SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { SurfaceInputAdmissionFailure, SurfaceInputControl, SurfaceInputExecutionResult } from '../../surfaces/inputControl';
import { classifyBrowserCommandCompletion } from '../control/types';
import {
  createBrowserAutomationOwnerRegistry,
  type BrowserAutomationOwnerRegistry,
  type BrowserAutomationViewRef,
} from './owners';

const TIMELINE_MAX_ENTRIES = 500;

// F3/G19: the one owner of "which verbs are declared but not executed" is the protocol
// (`browser/automation/notImplemented.ts`). The server publishes `supportedActions` from the same
// list, so a verb can never be refused here while advertised there — which had already happened
// once, when the server's hand-maintained copy silently stopped publishing `upload` and `drag`.
const NOT_IMPLEMENTED_ACTIONS: ReadonlySet<BrowserAutomationActionKindV1> = new Set(
  BROWSER_AUTOMATION_NOT_IMPLEMENTED_ACTION_KINDS,
);

type ActiveBrowserAutomationControllerKind = Exclude<BrowserAutomationControllerKindV1, 'none'>;

const AUTOMATION_CONTROLLER_BY_REQUESTER = {
  user: 'human',
  agent: 'agent',
  plugin: 'agent',
  system: 'system',
} as const satisfies Readonly<Record<BrowserAutomationRequesterKindV1, ActiveBrowserAutomationControllerKind>>;

function projectAutomationRequesterToController(
  requester: BrowserAutomationRequesterKindV1,
): ActiveBrowserAutomationControllerKind {
  return AUTOMATION_CONTROLLER_BY_REQUESTER[requester];
}

function browserAdmissionError(errorCode: SurfaceInputAdmissionFailure): BrowserAutomationErrorCodeV1 {
  switch (errorCode) {
    case 'busy': return 'automation_busy';
    case 'closed': return 'view_closed';
    case 'human_interrupted': return 'human_interrupted';
    case 'observation_required': return 'stale_navigation';
    case 'uncertain': return 'runtime_unavailable';
  }
}

export type BrowserAutomationCancelResult =
  | Readonly<{ ok: true; completion: 'stopped' | 'uncertain' }>
  | Readonly<{ ok: false; errorCode: 'owner_mismatch' | 'no_active_action' }>;

export type BrowserAutomationViewLifecycleSubscriber = (
  event: Readonly<{ type: 'bound' | 'unbound'; browserSessionId: string; viewId: string; sourceDestroyed?: boolean }>,
) => void;

/** Host policy admission retains the original caller; yielding control is not human input provenance. */
export type BrowserControllerAuthority = Readonly<
  | { authority: 'present_user' }
  | { authority: 'account_automation'; bypassApprovals: true }
>;

export type BrowserAutomationDaemonService = Readonly<{
  getInputControl(view: BrowserAutomationViewRef): SurfaceInputControl;
  prepareConfidentialFill(request: BrowserAutomationSecretFillRequestV1, context?: ActionExecutorContext): Promise<BrowserConfidentialFillPreparation>;
  execute(request: BrowserAutomationActionRequestV1, context?: Readonly<{ signal?: AbortSignal }>): Promise<BrowserAutomationActionResultV1>;
  cancelActive(
    input: BrowserAutomationViewRef & Readonly<{ authority: 'present_user' }>,
  ): Promise<BrowserAutomationCancelResult>;
  recordHumanInput(input: BrowserAutomationViewRef & BrowserControllerAuthority): Promise<BrowserAutomationCancelResult>;
  /** Page-changing control commands retain their host authority through the same admission and drain. */
  executeControlCommand(view: BrowserAutomationViewRef, authority: 'present_user' | 'account_automation', dispatch: () => Promise<BrowserCommandDispatchResultV1>): Promise<SurfaceInputExecutionResult<BrowserCommandDispatchResultV1>>;
  handBack(input: BrowserAutomationViewRef & BrowserControllerAuthority): Readonly<{ ok: boolean }>;
  getStatus(view: BrowserAutomationViewRef): BrowserAutomationControllerStateV1;
  getTimeline(view: BrowserAutomationViewRef): BrowserAutomationTimelineV1;
  closeView(view: BrowserAutomationViewRef): void;
  dispose(): void;
  getRuntimeStats(): Readonly<{ runtimeCount: number }>;
  /**
   * The action kinds the bound adapter supports (BA-6). `null` means the adapter declares no
   * `supportedOperations` set, so it accepts every kind (no up-front negotiation). The host/agent
   * reads this to negotiate before dispatching, avoiding a round-trip for an unsupported verb.
   */
  getSupportedOperations(): ReadonlySet<BrowserAutomationActionKindV1> | null;
  subscribeBrowserEvents(listener: (event: BrowserEventV1) => void): () => void;
}>;

type ViewRuntime = {
  navigationGeneration: number;
  timeline: BrowserAutomationTimelineEntryV1[];
  inputControl: SurfaceInputControl;
  /** Browser-only provenance/projection; inputControl owns admission and effect settlement. */
  activeAutomationRequestId: string | null;
  activeRequesterRef: BrowserAutomationRequesterRefV1 | null;
  activeController: BrowserAutomationControllerKindV1 | null;
  activeActionKind: BrowserAutomationActionKindV1 | null;
  activeTarget: BrowserActiveTargetV1 | null;
  confidentialPreparationActive: boolean;
};

export function createBrowserAutomationDaemonService(input: Readonly<{
  adapter: BrowserAutomationAdapter;
  owners?: BrowserAutomationOwnerRegistry;
  now?: () => number;
  generateTimelineEntryId?: () => string;
  subscribeViewLifecycle?: (listener: BrowserAutomationViewLifecycleSubscriber) => () => void;
}>): BrowserAutomationDaemonService {
  const now = input.now ?? (() => Date.now());
  const owners = input.owners ?? createBrowserAutomationOwnerRegistry();
  let timelineCounter = 0;
  const generateTimelineEntryId = input.generateTimelineEntryId
    ?? (() => `timeline_${(timelineCounter += 1)}_${now()}`);
  const runtimes = new Map<string, ViewRuntime>();
  const eventListeners = new Set<(event: BrowserEventV1) => void>();
  let eventSequence = 0;
  function emitController(view: BrowserAutomationViewRef): void {
    const runtime = runtimeFor(view);
    const event: BrowserEventV1 = { kind: 'controllerChanged', eventId: `automation:${++eventSequence}`, occurredAt: now(),
      browserSessionId: view.browserSessionId, viewId: view.viewId,
      navigationGeneration: input.adapter.getNavigationGeneration?.(view) ?? 0,
      state: controllerState(view, runtime) };
    for (const listener of [...eventListeners]) { try { listener(event); } catch { /* Observer cannot break admission. */ } }
  }
  const unsubscribeViewLifecycle = input.subscribeViewLifecycle?.((event) => {
    if (event.type === 'unbound') {
      closeView({ browserSessionId: event.browserSessionId, viewId: event.viewId }, event.sourceDestroyed);
    }
  }) ?? null;

  function runtimeFor(view: BrowserAutomationViewRef): ViewRuntime {
    const key = browserViewKey(view);
    const existing = runtimes.get(key);
    if (existing) return existing;
    const created: ViewRuntime = {
      navigationGeneration: 0,
      timeline: [],
      inputControl: owners.getInputControl(view),
      activeAutomationRequestId: null,
      activeRequesterRef: null,
      activeController: null,
      activeActionKind: null,
      activeTarget: null,
      confidentialPreparationActive: false,
    };
    runtimes.set(key, created);
    return created;
  }

  function appendTimeline(runtime: ViewRuntime, entry: BrowserAutomationTimelineEntryV1): void {
    runtime.timeline.push(entry);
    if (runtime.timeline.length > TIMELINE_MAX_ENTRIES) {
      runtime.timeline.splice(0, runtime.timeline.length - TIMELINE_MAX_ENTRIES);
    }
  }

  function controllerState(view: BrowserAutomationViewRef, runtime: ViewRuntime): BrowserAutomationControllerStateV1 {
    return { ...owners.getControllerState(view, { activeAutomationRequestId: runtime.activeAutomationRequestId,
      ...(runtime.activeController ? { controller: runtime.activeController } : {}) }),
      ...(runtime.activeActionKind ? { activeActionKind: runtime.activeActionKind } : {}),
      ...(runtime.activeTarget ? { activeTarget: runtime.activeTarget } : {}) };
  }

  function closeView(view: BrowserAutomationViewRef, sourceDestroyed = false): void {
    const key = browserViewKey(view);
    const runtime = runtimes.get(key);
    owners.closeView(view, { sourceDestroyed });
    if (!runtime?.activeAutomationRequestId) runtimes.delete(key);
  }

  function failureResult(
    request: BrowserAutomationActionRequestV1,
    controlEpoch: number,
    navigationGeneration: number,
    errorCode: BrowserAutomationErrorCodeV1,
  ): BrowserAutomationActionResultV1 {
    const entry = BrowserAutomationTimelineEntryV1Schema.parse({
      v: 1,
      timelineEntryId: generateTimelineEntryId(),
      automationRequestId: request.automationRequestId,
      browserSessionId: request.browserSessionId,
      viewId: request.viewId,
      actionKind: request.actionKind,
      requesterKind: request.requestedBy,
      status: 'failed',
      adapterKind: input.adapter.adapterKind,
      fidelity: 'unavailable',
      trustedInput: false,
      queuedAtMs: now(),
      navigationGenerationBefore: navigationGeneration,
      navigationGenerationAfter: navigationGeneration,
      controlEpochBefore: controlEpoch,
      controlEpochAfter: controlEpoch,
      reasonCode: errorCode,
    });
    appendTimeline(runtimeFor(request), entry);
    return BrowserAutomationActionResultV1Schema.parse({
      v: 1,
      automationRequestId: request.automationRequestId,
      status: 'failed',
      durationMs: 0,
      adapterKind: input.adapter.adapterKind,
      fidelity: 'unavailable',
      trustedInput: false,
      navigationGenerationBefore: navigationGeneration,
      navigationGenerationAfter: navigationGeneration,
      controlEpochBefore: controlEpoch,
      controlEpochAfter: controlEpoch,
      errorCode,
    });
  }

  async function execute(rawRequest: BrowserAutomationActionRequestV1, context?: Readonly<{ signal?: AbortSignal }>) {
    const parsed = BrowserAutomationActionRequestV1Schema.safeParse(rawRequest);
    const runtime = runtimeFor(rawRequest);
    const engineGeneration = input.adapter.getNavigationGeneration?.(rawRequest) ?? 0;
    if (runtime.navigationGeneration !== engineGeneration) runtime.inputControl.invalidateObservation();
    runtime.navigationGeneration = engineGeneration;
    const controlEpoch = owners.getControlEpoch(rawRequest);
    if (!parsed.success) {
      return failureResult(rawRequest, controlEpoch, runtime.navigationGeneration, 'unsupported_action');
    }
    const request = parsed.data;

    if (owners.isObservationHeld(request)) await owners.tryReleaseConfidentiality(request);
    if (owners.isObservationHeld(request) && request.requestedBy !== 'user') {
      return failureResult(request, controlEpoch, runtime.navigationGeneration, 'policy_denied');
    }

    if (NOT_IMPLEMENTED_ACTIONS.has(request.actionKind)) {
      return failureResult(request, controlEpoch, runtime.navigationGeneration, 'not_implemented');
    }

    // BA-6 supportedOperations negotiation: fail closed UP-FRONT (before lease acquisition or any
    // dispatch) when the bound adapter/host version does not support this operation. This is the
    // precise-reason fail-closed for engine-skew / mixed host versions — never a silent mis-route.
    if (input.adapter.supportedOperations && !input.adapter.supportedOperations.has(request.actionKind)) {
      return failureResult(request, controlEpoch, runtime.navigationGeneration, 'unsupported_action');
    }

    const mutating = isBrowserAutomationMutatingActionKind(request.actionKind);

    const requestedBy = request.requestedBy === 'user' ? 'human' : 'agent';
    const admissionFailure = mutating ? runtime.inputControl.getAdmissionFailure(requestedBy) : undefined;
    if (admissionFailure) {
      return failureResult(request, controlEpoch, runtime.navigationGeneration, browserAdmissionError(admissionFailure));
    }
    if (runtime.inputControl.isClosed()) return failureResult(request, controlEpoch, runtime.navigationGeneration, 'view_closed');
    if (mutating && request.navigationGeneration !== runtime.navigationGeneration) {
      return failureResult(request, controlEpoch, runtime.navigationGeneration, 'stale_navigation');
    }

    const navigationGenerationBefore = runtime.navigationGeneration;
    const navigationGenerationAfter = navigationGenerationBefore;

    const abortController = new AbortController();
    const cancelFromCaller = () => { abortController.abort('user_canceled'); };
    if (!mutating) {
      if (context?.signal?.aborted) cancelFromCaller();
      else context?.signal?.addEventListener('abort', cancelFromCaller, { once: true });
    }
    const effect = async (signal: AbortSignal) => {
      if (mutating) {
        runtime.activeAutomationRequestId = request.automationRequestId;
        runtime.activeRequesterRef = request.requesterRef;
        runtime.activeController = projectAutomationRequesterToController(request.requestedBy);
        runtime.activeActionKind = request.actionKind;
        emitController(request);
      }
      try {
        return await executeBrowserAutomationAction({
          request,
          adapter: input.adapter,
          controlEpoch,
          navigationGenerationBefore,
          navigationGenerationAfter,
          getNavigationGenerationAfter: () => input.adapter.getNavigationGeneration?.(request) ?? navigationGenerationBefore,
          now,
          generateTimelineEntryId,
          executionContext: { signal, deadlineMs: now() + request.timeoutMs,
            onActiveTarget: target => {
              if (!mutating || signal.aborted || runtime.activeAutomationRequestId !== request.automationRequestId) return;
              const parsed = BrowserActiveTargetV1Schema.safeParse(target);
              if (!parsed.success) return;
              runtime.activeTarget = parsed.data;
              emitController(request);
            } },
        });
      } finally {
        if (mutating) {
          runtime.activeAutomationRequestId = null;
          runtime.activeRequesterRef = null;
          runtime.activeController = null;
          runtime.activeActionKind = null;
          runtime.activeTarget = null;
        }
      }
    };

    const wasUncertainBeforeRead = runtime.inputControl.getStatus().uncertain;
    try {
      const readOutcome = !mutating ? await runtime.inputControl.observeWhile(() => effect(abortController.signal),
        outcome => outcome.interruptionCompletion === 'uncertain' ? 'unknown' : 'known') : undefined;
      if (!mutating && !readOutcome) return failureResult(request, controlEpoch, runtime.navigationGeneration, 'policy_denied');
      const execution = mutating ? await runtime.inputControl.execute({
        requestedBy,
        signal: context?.signal,
        effect,
        classifyCompletion: (outcome, signal) => outcome.interruptionCompletion === 'stopped' ? 'known'
          : signal.aborted || outcome.interruptionCompletion === 'uncertain' || outcome.result.status === 'canceled' ? 'unknown' : 'known',
      }) : { ok: true as const, value: readOutcome!, interrupted: abortController.signal.aborted,
        reason: abortController.signal.aborted ? 'user_canceled' : undefined };
      if (!execution.ok) {
        return failureResult(request, controlEpoch, runtime.navigationGeneration, browserAdmissionError(execution.errorCode));
      }
      const outcome = execution.value;
      const completion = outcome.interruptionCompletion ?? 'uncertain';
      if (execution.interrupted) {
        const cancelReason = execution.reason === 'view_closed' || execution.reason === 'owner_disconnected'
          ? execution.reason : 'user_canceled';
        const result = BrowserAutomationActionResultV1Schema.parse({ ...outcome.result,
          status: 'canceled', errorCode: cancelReason, controlEpochAfter: owners.getControlEpoch(request),
          resultSummary: { ...outcome.result.resultSummary, completion },
        });
        appendTimeline(runtime, BrowserAutomationTimelineEntryV1Schema.parse({ ...outcome.timelineEntry,
          status: 'canceled', reasonCode: cancelReason, controlEpochAfter: result.controlEpochAfter,
          resultSummary: { ...outcome.timelineEntry.resultSummary, completion },
        }));
        return result;
      }
      appendTimeline(runtime, outcome.timelineEntry);
      if (outcome.result.status === 'succeeded' && (request.actionKind === 'snapshot' || request.actionKind === 'semanticSnapshot')
        && owners.getControlEpoch(request) === controlEpoch
        && outcome.result.navigationGenerationBefore === outcome.result.navigationGenerationAfter
        && (input.adapter.getNavigationGeneration?.(request) ?? 0) === outcome.result.navigationGenerationAfter) {
        const wasUncertain = runtime.inputControl.getStatus().uncertain;
        if (runtime.inputControl.observe(controlEpoch) && wasUncertain) emitController(request);
      }
      return outcome.result;
    } finally {
      context?.signal?.removeEventListener('abort', cancelFromCaller);
      if (mutating) {
        if (runtime.inputControl.isClosed()) runtimes.delete(browserViewKey(request));
        else emitController(request);
      } else if (!wasUncertainBeforeRead && runtime.inputControl.getStatus().uncertain) emitController(request);
    }
  }

  async function recordHumanInput(cancelInput: BrowserAutomationViewRef & BrowserControllerAuthority): Promise<BrowserAutomationCancelResult> {
    const runtime = runtimeFor(cancelInput);
    const activeRequesterRef = runtime.activeRequesterRef;
    const interruption = runtime.inputControl.takeOver();
    runtime.activeTarget = null;
    emitController(cancelInput);
    // Provenance is stored atomically with admission. The route accepts only host-stamped
    // present-user authority or policy-admitted automation, never an input-supplied requester
    // identity. Approval to yield control does not turn an agent into a present user.
    if (runtime.activeAutomationRequestId && !activeRequesterRef) {
      return { ok: false, errorCode: 'owner_mismatch' };
    }
    const result = await interruption;
    return result.active || result.completion === 'unknown' ? { ok: true, completion: result.completion === 'known' ? 'stopped' : 'uncertain' }
      : { ok: false, errorCode: 'no_active_action' };
  }
  return {
    getInputControl: view => owners.getInputControl(view),
    async prepareConfidentialFill(request, context) {
      if (context?.authority !== 'present_user') return { status: 'refused', code: 'approval_required' };
      if (!input.adapter.prepareConfidentialFill) return { status: 'refused', code: 'field_verification_unsupported' };
      const runtime = runtimeFor(request);
      if (runtime.inputControl.isClosed()) return { status: 'refused', code: 'target_unavailable' };
      // A retained page-secret hold blocks observation, not a fresh reviewed human fill.
      // Only overlapping preparations are refused; the shared input owner still serializes input.
      if (runtime.confidentialPreparationActive) return { status: 'refused', code: 'observation_unavailable' };
      runtime.confidentialPreparationActive = true;
      const alreadyHeld = owners.isObservationHeld(request);
      const clearUnusedHold = () => {
        if (!alreadyHeld && runtime.inputControl.clearConfidentialityHold()) emitController(request);
      };
      const abandonPreparation = () => {
        runtime.confidentialPreparationActive = false;
        clearUnusedHold();
      };
      try {
        const hold = owners.acquireConfidentiality(request);
        emitController(request);
        await hold;
      }
      catch { abandonPreparation(); return { status: 'refused', code: 'observation_unavailable' }; }
      if (context.signal?.aborted || runtime.inputControl.isClosed()) {
        abandonPreparation(); return { status: 'refused', code: 'target_changed' };
      }
      let prepared: BrowserConfidentialFillPreparation;
      try { prepared = await input.adapter.prepareConfidentialFill(request); }
      catch { abandonPreparation(); return { status: 'refused', code: 'target_unavailable' }; }
      if ('status' in prepared) { abandonPreparation(); return prepared; }
      const target = prepared;
      let finished = false;
      owners.setConfidentialitySafetyCheck(request, () => target.isSafe?.() ?? Promise.resolve(false));
      const current = async () => {
        if (finished || runtime.inputControl.isClosed() || context.signal?.aborted) return false;
        const valid = await target.recheck().catch(() => false);
        return valid && !runtime.inputControl.isClosed() && !context.signal?.aborted;
      };
      const submit = target.submit;
      let filled = false;
      let issued = false;
      return {
        ...(target.nativeObservation === 'not_observable' ? { nativeObservation: 'not_observable' as const } : {}),
        recheck: current,
        async fill(value, signal, beforeDelivery) {
          if (issued) return { status: 'refused', code: 'approval_changed' };
          if (signal?.aborted || context.signal?.aborted) return { status: 'canceled', code: 'canceled' };
          if (!await current()) return { status: 'refused', code: 'target_changed' };
          const result = await runtime.inputControl.execute({ requestedBy: 'human', signal,
            effect: async physicalSignal => {
              if (physicalSignal.aborted || context.signal?.aborted) return { status: 'canceled', code: 'canceled' } satisfies SecretFillSettlementV1;
              if (!await current()) return { status: 'refused', code: 'target_changed' } satisfies SecretFillSettlementV1;
              issued = true;
              try { return SecretFillSettlementV1Schema.parse(await target.fill(value, physicalSignal, beforeDelivery)); }
              catch { return { status: 'unknown', code: 'delivery_unknown' } satisfies SecretFillSettlementV1; }
            },
            classifyCompletion: result => result.status === 'unknown' ? 'unknown' : 'known',
          });
          if (!result.ok) return { status: 'refused', code: 'target_changed' };
          filled = result.value.status === 'filled';
          return result.value;
        },
        ...(submit && request.submit ? { async submit(signal?: AbortSignal, beforeDelivery?: () => Promise<boolean>) {
          if (!filled || signal?.aborted || !await current()) return { status: 'refused', code: 'submit_refused' } as const;
          filled = false;
          const result = await runtime.inputControl.execute({ requestedBy: 'human', signal,
            effect: async physicalSignal => {
              if (physicalSignal.aborted || !await current()) return { status: 'refused', code: 'submit_refused' } as const;
              try { return await submit(physicalSignal, beforeDelivery); }
              catch { return { status: 'unknown', code: 'submit_unknown' } as const; }
            }, classifyCompletion: value => value.status === 'unknown' ? 'unknown' : 'known',
          });
          return result.ok ? result.value : { status: 'refused', code: 'submit_refused' } as const;
        } } : {}),
        async finish() {
          if (finished) return;
          finished = true;
          try {
            await target.finish();
            if (!issued) clearUnusedHold();
            else await owners.tryReleaseConfidentiality(request);
          } finally {
            runtime.confidentialPreparationActive = false;
            emitController(request);
          }
        },
      };
    },
    execute,
    async executeControlCommand(view, authority, dispatch) {
      const runtime = runtimeFor(view);
      if (authority === 'present_user') await recordHumanInput({ ...view, authority });
      const navigationGeneration = input.adapter.getNavigationGeneration?.(view) ?? 0;
      if (runtime.navigationGeneration !== navigationGeneration) runtime.inputControl.invalidateObservation();
      runtime.navigationGeneration = navigationGeneration;
      try {
        return await runtime.inputControl.execute({
          requestedBy: authority === 'present_user' ? 'human' : 'agent',
          effect: async () => {
            emitController(view);
            // The broker awaits the actual CDP acknowledgement. Keep admission until it settles;
            // abort cannot retract a page command already issued to Chromium.
            return await dispatch();
          },
          classifyCompletion: classifyBrowserCommandCompletion,
        });
      } finally { emitController(view); }
    },
    cancelActive: recordHumanInput,
    recordHumanInput,
    handBack(view) {
      const runtime = runtimeFor(view);
      if (!runtime.inputControl.handBack()) return { ok: false };
      emitController(view);
      return { ok: true };
    },
    getStatus(view) {
      const runtime = runtimeFor(view);
      return controllerState(view, runtime);
    },
    closeView,
    dispose() {
      unsubscribeViewLifecycle?.();
      for (const runtime of runtimes.values()) { void runtime.inputControl.close('owner_disconnected'); }
      eventListeners.clear();
    },
    getRuntimeStats: () => ({ runtimeCount: runtimes.size }),
    getTimeline(view) {
      const runtime = runtimeFor(view);
      return BrowserAutomationTimelineV1Schema.parse({
        v: 1,
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        maxEntries: TIMELINE_MAX_ENTRIES,
        entries: runtime.timeline,
      });
    },
    getSupportedOperations: () => input.adapter.supportedOperations ?? null,
    subscribeBrowserEvents(listener) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
  };
}
