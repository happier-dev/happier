import {
  browserViewKey,
  BrowserAutomationActionRequestV1Schema,
  BrowserAutomationActionResultV1Schema,
  BrowserAutomationTimelineEntryV1Schema,
  BrowserAutomationTimelineV1Schema,
  isBrowserAutomationMutatingActionKind,
  type BrowserAutomationActionKindV1,
  type BrowserAutomationActionRequestV1,
  type BrowserAutomationActionResultV1,
  type BrowserAutomationControllerKindV1,
  type BrowserAutomationControllerStateV1,
  type BrowserAutomationErrorCodeV1,
  type BrowserAutomationRequesterKindV1,
  type BrowserAutomationRequesterRefV1,
  type BrowserAutomationTimelineEntryV1,
  type BrowserAutomationTimelineV1,
} from '@happier-dev/protocol';

import { executeBrowserAutomationAction } from './actions';
import type { BrowserAutomationAdapter } from './adapters/types';
import {
  createBrowserAutomationOwnerRegistry,
  type BrowserAutomationOwnerRegistry,
  type BrowserAutomationViewRef,
} from './owners';

const TIMELINE_MAX_ENTRIES = 500;

// Mutating action kinds that change the navigation generation when they succeed.
const NAVIGATION_GENERATION_ACTIONS = new Set([
  'navigate',
  'reload',
  'goBack',
  'goForward',
]);

const NOT_IMPLEMENTED_ACTIONS = new Set<BrowserAutomationActionKindV1>([
  'evaluate',
  'startElementPicker',
  'cancelElementPicker',
]);

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

export type BrowserAutomationCancelResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode: 'owner_mismatch' | 'no_active_action' }>;

export type BrowserAutomationViewLifecycleSubscriber = (
  event: Readonly<{ type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }>,
) => void;

export type BrowserAutomationDaemonService = Readonly<{
  execute(request: BrowserAutomationActionRequestV1): Promise<BrowserAutomationActionResultV1>;
  cancelActive(
    input: BrowserAutomationViewRef & Readonly<{ requesterRef: { kind: string; id: string } }>,
  ): BrowserAutomationCancelResult;
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
}>;

type ViewRuntime = {
  navigationGeneration: number;
  timeline: BrowserAutomationTimelineEntryV1[];
  /**
   * Single-flight: the one mutating automation action in flight for this view, with the provenance
   * that admitted it. One object, one owner — `cancelActive` compares against this requester, and
   * `getStatus` projects it, so there is no second copy of "who is driving this view".
   */
  activeAutomationRequestId: string | null;
  activeRequesterRef: BrowserAutomationRequesterRefV1 | null;
  activeController: BrowserAutomationControllerKindV1 | null;
  cancel: ((errorCode: BrowserAutomationErrorCodeV1) => void) | null;
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
  const unsubscribeViewLifecycle = input.subscribeViewLifecycle?.((event) => {
    if (event.type === 'unbound') {
      closeView({ browserSessionId: event.browserSessionId, viewId: event.viewId });
    }
  }) ?? null;

  function runtimeFor(view: BrowserAutomationViewRef): ViewRuntime {
    const key = browserViewKey(view);
    const existing = runtimes.get(key);
    if (existing) return existing;
    const created: ViewRuntime = {
      navigationGeneration: 0,
      timeline: [],
      activeAutomationRequestId: null,
      activeRequesterRef: null,
      activeController: null,
      cancel: null,
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

  function closeView(view: BrowserAutomationViewRef): void {
    const key = browserViewKey(view);
    const runtime = runtimes.get(key);
    runtime?.cancel?.('view_closed');
    runtimes.delete(key);
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

  async function execute(rawRequest: BrowserAutomationActionRequestV1) {
    const parsed = BrowserAutomationActionRequestV1Schema.safeParse(rawRequest);
    const runtime = runtimeFor(rawRequest);
    const controlEpoch = owners.getControlEpoch(rawRequest);
    if (!parsed.success) {
      return failureResult(rawRequest, controlEpoch, runtime.navigationGeneration, 'unsupported_action');
    }
    const request = parsed.data;

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

    // Single-flight is the whole arbitration for a mutating action. Consent is enforced upstream by
    // the action-approval danger floor, and human takeover cancels the in-flight action; neither is
    // this check's job. (An action lease used to sit here and no code path could mint one, so every
    // mutating verb was undispatchable — G3/OE-1.)
    if (mutating && runtime.activeAutomationRequestId) {
      return failureResult(request, controlEpoch, runtime.navigationGeneration, 'automation_busy');
    }

    const navigationGenerationBefore = runtime.navigationGeneration;
    const navigationGenerationAfter = NAVIGATION_GENERATION_ACTIONS.has(request.actionKind)
      ? navigationGenerationBefore + 1
      : navigationGenerationBefore;

    if (mutating) {
      runtime.activeAutomationRequestId = request.automationRequestId;
      runtime.activeRequesterRef = request.requesterRef;
      runtime.activeController = projectAutomationRequesterToController(request.requestedBy);
    }

    const cancellation = new Promise<{ canceled: true; errorCode: BrowserAutomationErrorCodeV1 }>((resolve) => {
      if (mutating) {
        runtime.cancel = (errorCode) => resolve({ canceled: true, errorCode });
      }
    });

    try {
      const actionPromise = executeBrowserAutomationAction({
        request,
        adapter: input.adapter,
        controlEpoch,
        navigationGenerationBefore,
        navigationGenerationAfter,
        now,
        generateTimelineEntryId,
      });

      const raced = mutating
        ? await Promise.race([
            actionPromise.then((outcome) => ({ canceled: false as const, outcome })),
            cancellation,
          ])
        : { canceled: false as const, outcome: await actionPromise };

      if (raced.canceled) {
        const canceledOutcome = await buildCanceledOutcome({
          request,
          adapterKind: input.adapter.adapterKind,
          controlEpoch,
          navigationGenerationBefore,
          errorCode: raced.errorCode,
          now,
          generateTimelineEntryId,
        });
        appendTimeline(runtime, canceledOutcome.timelineEntry);
        // Drain the underlying action so the adapter promise cannot leak unhandled.
        void actionPromise.catch(() => undefined);
        return canceledOutcome.result;
      }

      appendTimeline(runtime, raced.outcome.timelineEntry);
      if (
        raced.outcome.result.status === 'succeeded'
        && NAVIGATION_GENERATION_ACTIONS.has(request.actionKind)
      ) {
        runtime.navigationGeneration = navigationGenerationAfter;
      }
      return raced.outcome.result;
    } finally {
      if (mutating) {
        runtime.activeAutomationRequestId = null;
        runtime.activeRequesterRef = null;
        runtime.activeController = null;
        runtime.cancel = null;
      }
    }
  }

  return {
    execute,
    cancelActive(cancelInput) {
      const runtime = runtimeFor(cancelInput);
      if (!runtime.activeAutomationRequestId || !runtime.cancel) {
        return { ok: false, errorCode: 'no_active_action' };
      }
      // Provenance for the in-flight action, recorded at admission. Before the lease was removed
      // this read the lease's requester, which no request could ever carry, so `owner_mismatch`
      // was unreachable and any caller could cancel any agent's action.
      const activeRequesterRef = runtime.activeRequesterRef;
      if (
        activeRequesterRef
        && (activeRequesterRef.kind !== cancelInput.requesterRef.kind
          || activeRequesterRef.id !== cancelInput.requesterRef.id)
      ) {
        return { ok: false, errorCode: 'owner_mismatch' };
      }
      runtime.cancel('user_canceled');
      return { ok: true };
    },
    getStatus(view) {
      const runtime = runtimeFor(view);
      return owners.getControllerState(view, {
        activeAutomationRequestId: runtime.activeAutomationRequestId,
        ...(runtime.activeController ? { controller: runtime.activeController } : {}),
      });
    },
    closeView,
    dispose() {
      unsubscribeViewLifecycle?.();
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
  };
}

async function buildCanceledOutcome(input: Readonly<{
  request: BrowserAutomationActionRequestV1;
  adapterKind: BrowserAutomationAdapter['adapterKind'];
  controlEpoch: number;
  navigationGenerationBefore: number;
  errorCode: BrowserAutomationErrorCodeV1;
  now: () => number;
  generateTimelineEntryId: () => string;
}>): Promise<{ result: BrowserAutomationActionResultV1; timelineEntry: BrowserAutomationTimelineEntryV1 }> {
  const at = input.now();
  const result = BrowserAutomationActionResultV1Schema.parse({
    v: 1,
    automationRequestId: input.request.automationRequestId,
    status: 'canceled',
    durationMs: 0,
    adapterKind: input.adapterKind,
    fidelity: 'unavailable',
    trustedInput: false,
    navigationGenerationBefore: input.navigationGenerationBefore,
    navigationGenerationAfter: input.navigationGenerationBefore,
    controlEpochBefore: input.controlEpoch,
    controlEpochAfter: input.controlEpoch,
    errorCode: input.errorCode,
  });
  const timelineEntry = BrowserAutomationTimelineEntryV1Schema.parse({
    v: 1,
    timelineEntryId: input.generateTimelineEntryId(),
    automationRequestId: input.request.automationRequestId,
    browserSessionId: input.request.browserSessionId,
    viewId: input.request.viewId,
    actionKind: input.request.actionKind,
    requesterKind: input.request.requestedBy,
    status: 'canceled',
    adapterKind: input.adapterKind,
    fidelity: 'unavailable',
    trustedInput: false,
    queuedAtMs: at,
    finishedAtMs: at,
    navigationGenerationBefore: input.navigationGenerationBefore,
    navigationGenerationAfter: input.navigationGenerationBefore,
    controlEpochBefore: input.controlEpoch,
    controlEpochAfter: input.controlEpoch,
    reasonCode: input.errorCode,
  });
  return { result, timelineEntry };
}
