import {
    browserViewKey,
    BrowserActiveTargetV1Schema,
    type BrowserActiveTargetV1,
    BrowserAutomationCancelActiveResultV1Schema,
    BrowserAutomationActionResultV1Schema,
    BrowserAutomationErrorCodeV1Schema,
    BrowserAutomationActionKindV1Schema,
    isBrowserAutomationMutatingActionKind,
    redactBrowserAutomationActionResultDetails,
    redactBrowserAutomationTimelineDetails,
    type BrowserAutomationCancelActiveResultV1,
    type BrowserAutomationErrorCodeV1,
    type BrowserAutomationActionResultV1,
} from '@happier-dev/protocol';

export type BrowserAutomationAuthority = 'uiLocal' | 'daemon' | 'serverBroker';
export type BrowserAutomationRequesterKind = 'agent' | 'plugin' | 'system' | 'user';
export type BrowserAutomationResultStatus =
    | 'succeeded'
    | 'failed'
    | 'interrupted'
    | 'canceled'
    | 'timed_out'
    | 'stale'
    | 'policy_denied'
    | 'unsupported';

export type BrowserAutomationRequest = Readonly<{
    v: 1;
    automationRequestId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    requestedBy: BrowserAutomationRequesterKind;
    requesterRef: Readonly<{
        kind: string;
        id: string;
    }>;
    actionKind: string;
    timeoutMs: number;
    payload?: Readonly<Record<string, unknown>>;
}>;

export type BrowserAutomationResult = Readonly<{
    status: BrowserAutomationResultStatus;
    completion?: 'unknown';
    errorCode?: BrowserAutomationErrorCodeV1;
    automationRequestId?: string;
    durationMs?: number;
    resultSummary?: Readonly<Record<string, unknown>>;
    actionResult?: BrowserAutomationActionResultV1;
}>;

export type BrowserAutomationOwner = Readonly<{
    ownerId: string;
    authority: BrowserAutomationAuthority;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    adapterKind: string;
    fidelity: string;
    trustedInput: boolean;
    supportedActions: readonly string[];
    executeAction: (
        request: BrowserAutomationRequest,
        context: Readonly<{ signal: AbortSignal; onActiveTarget?: (target: BrowserActiveTargetV1) => void }>,
    ) => Promise<BrowserAutomationResult>;
}>;

export type BrowserAutomationTimelineEntry = Readonly<{
    timelineEntryId: string;
    automationRequestId: string;
    browserSessionId: string;
    viewId: string;
    actionKind: string;
    requesterKind: BrowserAutomationRequesterKind;
    status: BrowserAutomationResultStatus;
    adapterKind: string;
    fidelity: string;
    trustedInput: boolean;
    queuedAtMs: number;
    startedAtMs?: number;
    finishedAtMs?: number;
    durationMs?: number;
    navigationGenerationBefore: number;
    navigationGenerationAfter: number;
    controlEpochBefore: number;
    controlEpochAfter: number;
    targetSummary: unknown;
    resultSummary: unknown;
    reasonCode?: BrowserAutomationErrorCodeV1;
}>;

/**
 * Who drives a view. `activeAutomationRequestId` is the single-flight fact and the only
 * concurrency arbitration; `controlEpoch` advances when a human takes over. There is deliberately
 * no lease — one existed until 2026-08-23 with no minting path, which made every mutating verb
 * undispatchable (G3/OE-1). Consent is the action-approval danger floor, not a lease.
 */
type BrowserAutomationControllerState = {
    controller: 'none' | 'human' | 'agent' | 'system';
    controlEpoch: number;
    activeAutomationRequestId: string | null;
    activeRequesterRef: Readonly<{ kind: string; id: string }> | null;
    /** The in-flight action's kind, so a surface can say what is happening ("Typing"). */
    activeActionKind: string | null;
    activeTarget: BrowserActiveTargetV1 | null;
    humanHeld: boolean;
    requiresObservation: boolean;
};

type ActiveAction = {
    request: BrowserAutomationRequest;
    owner: BrowserAutomationOwner;
    abortController: AbortController;
    queuedAtMs: number;
    startedAtMs: number;
    controlEpochBefore: number;
    navigationGenerationBefore: number;
    settled: boolean;
    /** Retirement outlives eviction from the recent-closed-view projection. */
    viewClosed?: true;
    interruption?: BrowserAutomationResult;
    detachCallerAbort?: () => void;
    timeoutId: ReturnType<typeof setTimeout> | null;
    resolve: (result: BrowserAutomationResult) => void;
};

export type BrowserAutomationControlService = Readonly<{
    registerOwner: (owner: BrowserAutomationOwner) => Readonly<{ ok: true } | { ok: false; reasonCode: BrowserAutomationErrorCodeV1 }>;
    unregisterOwner: (input: Readonly<{ ownerId: string; reasonCode: BrowserAutomationErrorCodeV1 }>) => void;
    closeView: (input: Readonly<{ browserSessionId: string; viewId: string }>) => void;
    updateNavigationGeneration: (
        input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number }>,
    ) => void;
    executeAction: (request: BrowserAutomationRequest, options?: Readonly<{ signal?: AbortSignal }>) => Promise<BrowserAutomationResult>;
    cancelActiveAction: (
        input: Readonly<{ browserSessionId: string; viewId: string; reasonCode?: BrowserAutomationErrorCodeV1 }>,
    ) => BrowserAutomationCancelActiveResultV1;
    recordHumanInput: (
        input: Readonly<{ browserSessionId: string; viewId: string; inputKind: string; occurredAtMs: number }>,
    ) => void;
    releaseHumanControl: (input: Readonly<{ browserSessionId: string; viewId: string }>) => boolean;
    getActionTimeline: (
        input: Readonly<{ browserSessionId: string; viewId: string }>,
    ) => readonly BrowserAutomationTimelineEntry[];
    getStatus: (request: BrowserAutomationRequest) => BrowserAutomationActionResultV1 | null;
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => Readonly<Record<string, unknown>>;
}>;

const CLOSED_VIEW_KEY_LIMIT = 512;

function isMutatingAction(actionKind: string): boolean {
    const parsed = BrowserAutomationActionKindV1Schema.safeParse(actionKind);
    return parsed.success && isBrowserAutomationMutatingActionKind(parsed.data);
}

function unavailableResult(status: BrowserAutomationResultStatus, errorCode: BrowserAutomationErrorCodeV1): BrowserAutomationResult {
    return { status, errorCode };
}

function readKnownAutomationErrorCode(error: unknown): BrowserAutomationErrorCodeV1 | null {
    if (typeof error === 'string') {
        const parsed = BrowserAutomationErrorCodeV1Schema.safeParse(error);
        return parsed.success ? parsed.data : null;
    }
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    const data = error as Record<string, unknown>;
    for (const key of ['errorCode', 'reasonCode', 'code']) {
        const parsed = BrowserAutomationErrorCodeV1Schema.safeParse(data[key]);
        if (parsed.success) return parsed.data;
    }
    return null;
}

function summarizeRawFailure(error: unknown): Record<string, unknown> {
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        return { message: String(error) };
    }
    const data = error as Record<string, unknown>;
    return {
        ...(typeof data.name === 'string' ? { name: data.name } : {}),
        ...(typeof data.message === 'string' ? { message: data.message } : {}),
        ...(typeof data.errorCode === 'string' ? { errorCode: data.errorCode } : {}),
        ...(typeof data.reasonCode === 'string' ? { reasonCode: data.reasonCode } : {}),
        ...(typeof data.code === 'string' ? { code: data.code } : {}),
    };
}

export function createBrowserAutomationControlService(
    input: Readonly<{ nowMs: () => number; maxTimelineEntries?: number }>,
): BrowserAutomationControlService {
    const maxTimelineEntries = Math.max(1, Math.min(input.maxTimelineEntries ?? 500, 500));
    let nextTimelineSeq = 0;
    const ownersByViewKey = new Map<string, BrowserAutomationOwner>();
    const ownerIdToViewKey = new Map<string, string>();
    const controllersByViewKey = new Map<string, BrowserAutomationControllerState>();
    const activeActionsByRequestId = new Map<string, ActiveAction>();
    const timelineByViewKey = new Map<string, BrowserAutomationTimelineEntry[]>();
    const closedViewKeys = new Set<string>();
    const listeners = new Set<() => void>();

    function now(): number {
        return input.nowMs();
    }

    function emitChange(): void {
        for (const listener of [...listeners]) {
            listener();
        }
    }

    function controllerFor(viewKey: string): BrowserAutomationControllerState {
        const existing = controllersByViewKey.get(viewKey);
        if (existing) return existing;
        const next: BrowserAutomationControllerState = {
            controller: 'none',
            controlEpoch: 0,
            activeAutomationRequestId: null,
            activeRequesterRef: null,
            activeActionKind: null,
            activeTarget: null,
            humanHeld: false,
            requiresObservation: false,
        };
        controllersByViewKey.set(viewKey, next);
        return next;
    }

    function projectActionResult(active: ActiveAction, result: BrowserAutomationResult): BrowserAutomationActionResultV1 {
        return BrowserAutomationActionResultV1Schema.parse({
            v: 1,
            automationRequestId: active.request.automationRequestId,
            status: result.status,
            durationMs: Math.max(0, now() - active.startedAtMs),
            adapterKind: active.owner.adapterKind,
            fidelity: active.owner.fidelity,
            trustedInput: active.owner.trustedInput,
            navigationGenerationBefore: active.navigationGenerationBefore,
            navigationGenerationAfter: active.owner.navigationGeneration,
            controlEpochBefore: active.controlEpochBefore,
            controlEpochAfter: controllerFor(browserViewKey(active.request)).controlEpoch,
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            resultSummary: redactBrowserAutomationActionResultDetails(result.resultSummary ?? {}),
        });
    }

    function appendTimeline(active: ActiveAction, result: BrowserAutomationResult): void {
        const viewKey = browserViewKey(active.request);
        const controller = controllerFor(viewKey);
        nextTimelineSeq += 1;
        const finishedAtMs = now();
        const entries = timelineByViewKey.get(viewKey) ?? [];
        const resultSummary = result.resultSummary
            ? { status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...result.resultSummary }
            : result;
        const nextEntries = [
            ...entries,
            {
                timelineEntryId: `browser_automation_timeline:${nextTimelineSeq}`,
                automationRequestId: active.request.automationRequestId,
                browserSessionId: active.request.browserSessionId,
                viewId: active.request.viewId,
                actionKind: active.request.actionKind,
                requesterKind: active.request.requestedBy,
                status: result.status,
                adapterKind: active.owner.adapterKind,
                fidelity: active.owner.fidelity,
                trustedInput: active.owner.trustedInput,
                queuedAtMs: active.queuedAtMs,
                startedAtMs: active.startedAtMs,
                finishedAtMs,
                durationMs: Math.max(0, finishedAtMs - active.startedAtMs),
                navigationGenerationBefore: active.navigationGenerationBefore,
                navigationGenerationAfter: active.owner.navigationGeneration,
                controlEpochBefore: active.controlEpochBefore,
                controlEpochAfter: controller.controlEpoch,
                targetSummary: redactBrowserAutomationTimelineDetails(active.request.payload ?? {}),
                resultSummary: redactBrowserAutomationTimelineDetails(resultSummary),
                ...(result.errorCode ? { reasonCode: result.errorCode } : {}),
            } satisfies BrowserAutomationTimelineEntry,
        ].slice(-maxTimelineEntries);
        timelineByViewKey.set(viewKey, nextEntries);
    }

    function finishActiveAction(active: ActiveAction, result: BrowserAutomationResult): void {
        if (active.settled) return;
        result = active.interruption ?? result;
        active.settled = true;
        active.detachCallerAbort?.();
        if (active.timeoutId) {
            clearTimeout(active.timeoutId);
            active.timeoutId = null;
        }
        activeActionsByRequestId.delete(active.request.automationRequestId);
        if (!active.abortController.signal.aborted && result.status !== 'succeeded' && result.status !== 'failed') {
            active.abortController.abort(result.errorCode ?? result.status);
        }
        const viewKey = browserViewKey(active.request);
        const controller = controllerFor(viewKey);
        if (controller.activeAutomationRequestId === active.request.automationRequestId) {
            controller.activeAutomationRequestId = null;
            controller.activeRequesterRef = null;
            controller.activeActionKind = null;
            controller.activeTarget = null;
            controller.controller = controller.humanHeld ? 'human' : 'none';
        }
        if (result.status === 'succeeded' && (active.request.actionKind === 'snapshot' || active.request.actionKind === 'semanticSnapshot')
            && controller.controlEpoch === active.controlEpochBefore
            && ownersByViewKey.get(viewKey)?.navigationGeneration === active.request.navigationGeneration) controller.requiresObservation = false;
        const actionResult = projectActionResult(active, result);
        if (!active.viewClosed) {
            appendTimeline(active, result);
        } else if (!ownersByViewKey.has(viewKey)
            && ![...activeActionsByRequestId.values()].some((pending) => browserViewKey(pending.request) === viewKey)) {
            // Closing waits for engine settlement without reviving the retired view's state.
            controllersByViewKey.delete(viewKey);
            timelineByViewKey.delete(viewKey);
        }
        active.resolve({
            ...result,
            automationRequestId: active.request.automationRequestId,
            durationMs: Math.max(0, now() - active.startedAtMs),
            actionResult,
        });
        emitChange();
    }

    function interruptActiveAction(active: ActiveAction, result: BrowserAutomationResult): void {
        if (active.settled || active.interruption) return;
        active.interruption = { ...result, resultSummary: { ...result.resultSummary, completion: 'uncertain' } };
        if (active.timeoutId) { clearTimeout(active.timeoutId); active.timeoutId = null; }
        active.abortController.abort(result.errorCode ?? result.status);
        // The engine boundary must settle before admission is released. UI injected-page aborts
        // have no physical effect acknowledgement, so cancellation never promises stopped/undo.
    }

    function cancelActiveActionsForView(
        viewKey: string,
        status: BrowserAutomationResultStatus,
        errorCode: BrowserAutomationErrorCodeV1,
        predicate: (active: ActiveAction) => boolean = () => true,
    ): number {
        let canceledCount = 0;
        for (const active of [...activeActionsByRequestId.values()]) {
            if (browserViewKey(active.request) !== viewKey || !predicate(active)) continue;
            interruptActiveAction(active, { status, errorCode });
            canceledCount += 1;
        }
        return canceledCount;
    }

    function rejectAndRecord(
        request: BrowserAutomationRequest,
        owner: BrowserAutomationOwner | null,
        status: BrowserAutomationResultStatus,
        errorCode: BrowserAutomationErrorCodeV1,
    ): BrowserAutomationResult {
        if (!owner) return unavailableResult(status, errorCode);
        const syntheticActive: ActiveAction = {
            request,
            owner,
            abortController: new AbortController(),
            queuedAtMs: now(),
            startedAtMs: now(),
            controlEpochBefore: controllerFor(browserViewKey(request)).controlEpoch,
            navigationGenerationBefore: owner.navigationGeneration,
            settled: false,
            timeoutId: null,
            resolve: () => undefined,
        };
        appendTimeline(syntheticActive, { status, errorCode });
        return { ...unavailableResult(status, errorCode), actionResult: projectActionResult(syntheticActive, { status, errorCode }) };
    }

    /**
     * Single-flight admission for a mutating action: at most one runs per view. This is the whole
     * arbitration. It replaced a lease that no caller could mint, so the check it nominally
     * performed never actually ran — this one does, on the real dispatch path.
     */
    function admitMutatingAction(request: BrowserAutomationRequest): BrowserAutomationResult | null {
        if (!isMutatingAction(request.actionKind)) return null;
        const controller = controllerFor(browserViewKey(request));
        if (controller.activeAutomationRequestId) return unavailableResult('policy_denied', 'automation_busy');
        if (request.requestedBy !== 'user' && controller.humanHeld) return unavailableResult('interrupted', 'human_interrupted');
        if (request.requestedBy !== 'user' && controller.requiresObservation) return unavailableResult('stale', 'stale_navigation');
        return null;
    }

    function handleHumanInput(inputValue: Readonly<{
        browserSessionId: string;
        viewId: string;
        occurredAtMs: number;
    }>): void {
        const viewKey = browserViewKey(inputValue);
        const controller = controllerFor(viewKey);
        if (!controller.humanHeld) controller.controlEpoch += 1;
        controller.humanHeld = true;
        controller.activeTarget = null;
        controller.requiresObservation = true;
        controller.controller = 'human';
        cancelActiveActionsForView(viewKey, 'interrupted', 'human_interrupted', (active) => (
            isMutatingAction(active.request.actionKind)
            && active.request.requestedBy !== 'user'
        ));
    }

    return {
        registerOwner(owner) {
            const viewKey = browserViewKey(owner);
            const existing = ownersByViewKey.get(viewKey);
            if (existing && existing.ownerId !== owner.ownerId) {
                return { ok: false, reasonCode: 'owner_conflict' };
            }
            closedViewKeys.delete(viewKey);
            ownersByViewKey.set(viewKey, owner);
            ownerIdToViewKey.set(owner.ownerId, viewKey);
            controllerFor(viewKey);
            emitChange();
            return { ok: true };
        },

        unregisterOwner({ ownerId, reasonCode }) {
            const viewKey = ownerIdToViewKey.get(ownerId);
            if (!viewKey) return;
            ownerIdToViewKey.delete(ownerId);
            ownersByViewKey.delete(viewKey);
            cancelActiveActionsForView(viewKey, 'canceled', reasonCode || 'owner_disconnected');
            emitChange();
        },

        closeView(inputValue) {
            const viewKey = browserViewKey(inputValue);
            closedViewKeys.add(viewKey);
            const owner = ownersByViewKey.get(viewKey);
            if (owner) {
                ownerIdToViewKey.delete(owner.ownerId);
            }
            ownersByViewKey.delete(viewKey);
            for (const active of activeActionsByRequestId.values()) {
                if (browserViewKey(active.request) === viewKey) active.viewClosed = true;
            }
            cancelActiveActionsForView(viewKey, 'canceled', 'view_closed');
            if (!controllerFor(viewKey).activeAutomationRequestId) controllersByViewKey.delete(viewKey);
            timelineByViewKey.delete(viewKey);
            while (closedViewKeys.size > CLOSED_VIEW_KEY_LIMIT) {
                const oldest = closedViewKeys.values().next().value;
                if (typeof oldest === 'string') {
                    closedViewKeys.delete(oldest);
                } else {
                    break;
                }
            }
            emitChange();
        },

        updateNavigationGeneration(inputValue) {
            const viewKey = browserViewKey(inputValue);
            const owner = ownersByViewKey.get(viewKey);
            if (owner) {
                if (owner.navigationGeneration !== inputValue.navigationGeneration) controllerFor(viewKey).requiresObservation = true;
                ownersByViewKey.set(viewKey, {
                    ...owner,
                    navigationGeneration: inputValue.navigationGeneration,
                });
            }
            cancelActiveActionsForView(viewKey, 'stale', 'stale_navigation', (active) => (
                active.request.navigationGeneration !== inputValue.navigationGeneration
            ));
            emitChange();
        },

        executeAction(request, options) {
            const viewKey = browserViewKey(request);
            const owner = ownersByViewKey.get(viewKey) ?? null;
            if (closedViewKeys.has(viewKey)) {
                return Promise.resolve(rejectAndRecord(request, owner, 'canceled', 'view_closed'));
            }
            if (!owner) {
                return Promise.resolve(unavailableResult('canceled', 'owner_disconnected'));
            }
            if (options?.signal?.aborted) {
                return Promise.resolve(rejectAndRecord(request, owner, 'canceled', 'user_canceled'));
            }
            if (request.navigationGeneration !== owner.navigationGeneration) {
                return Promise.resolve(rejectAndRecord(request, owner, 'stale', 'stale_navigation'));
            }
            if (!owner.supportedActions.includes(request.actionKind)) {
                return Promise.resolve(rejectAndRecord(request, owner, 'unsupported', 'unsupported_action'));
            }
            const admissionError = admitMutatingAction(request);
            if (admissionError) {
                return Promise.resolve(rejectAndRecord(
                    request,
                    owner,
                    admissionError.status,
                    admissionError.errorCode ?? 'policy_denied',
                ));
            }

            const controller = controllerFor(viewKey);
            const abortController = new AbortController();
            const active: ActiveAction = {
                request,
                owner,
                abortController,
                queuedAtMs: now(),
                startedAtMs: now(),
                controlEpochBefore: controller.controlEpoch,
                navigationGenerationBefore: owner.navigationGeneration,
                settled: false,
                timeoutId: null,
                resolve: () => undefined,
            };

            const resultPromise = new Promise<BrowserAutomationResult>((resolve) => {
                active.resolve = resolve;
            });
            activeActionsByRequestId.set(request.automationRequestId, active);
            if (isMutatingAction(request.actionKind)) {
                controller.activeAutomationRequestId = request.automationRequestId;
                controller.activeRequesterRef = request.requesterRef;
                controller.activeActionKind = request.actionKind;
                controller.controller = controller.humanHeld || request.requestedBy === 'user' ? 'human' : request.requestedBy === 'system' ? 'system' : 'agent';
            }
            emitChange();
            active.timeoutId = setTimeout(() => {
                interruptActiveAction(active, { status: 'timed_out', errorCode: 'timed_out' });
            }, request.timeoutMs);

            const callerSignal = options?.signal;
            if (callerSignal) {
                const onAbort = () => interruptActiveAction(active, {
                    status: 'interrupted', errorCode: 'user_canceled', completion: 'unknown',
                });
                callerSignal.addEventListener('abort', onAbort, { once: true });
                active.detachCallerAbort = () => callerSignal.removeEventListener('abort', onAbort);
                if (callerSignal.aborted) {
                    finishActiveAction(active, { status: 'canceled', errorCode: 'user_canceled' });
                    return resultPromise;
                }
            }

            owner.executeAction(request, { signal: abortController.signal, onActiveTarget: target => {
                if (active.settled || active.interruption || abortController.signal.aborted
                    || controller.activeAutomationRequestId !== request.automationRequestId) return;
                const parsed = BrowserActiveTargetV1Schema.safeParse(target);
                if (!parsed.success) return;
                controller.activeTarget = parsed.data;
                emitChange();
            } }).then((result) => {
                finishActiveAction(active, result);
            }).catch((error) => {
                finishActiveAction(active, {
                    status: 'failed',
                    errorCode: readKnownAutomationErrorCode(error) ?? 'runtime_unavailable',
                    resultSummary: { rawFailure: summarizeRawFailure(error) },
                });
            });

            return resultPromise;
        },

        cancelActiveAction(inputValue) {
            const canceledCount = cancelActiveActionsForView(
                browserViewKey(inputValue),
                'canceled',
                inputValue.reasonCode ?? 'user_canceled',
            );
            handleHumanInput({ ...inputValue, occurredAtMs: now() });
            emitChange();
            return BrowserAutomationCancelActiveResultV1Schema.parse(
                canceledCount > 0
                    ? { v: 1, outcome: 'canceled', canceledCount, completion: 'uncertain' }
                    : { v: 1, outcome: 'no_active', canceledCount: 0 },
            );
        },

        recordHumanInput(inputValue) {
            handleHumanInput(inputValue);
            emitChange();
        },

        releaseHumanControl(view) {
            const controller = controllerFor(browserViewKey(view));
            if (controller.activeAutomationRequestId) return false;
            if (controller.humanHeld) controller.controlEpoch += 1;
            controller.humanHeld = false;
            controller.controller = 'none';
            controller.requiresObservation = true;
            emitChange();
            return true;
        },

        getActionTimeline(inputValue) {
            return [...(timelineByViewKey.get(browserViewKey(inputValue)) ?? [])];
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        getStatus(request) {
            const viewKey = browserViewKey(request);
            const owner = ownersByViewKey.get(viewKey);
            if (!owner) return null;
            const controller = controllerFor(viewKey);
            return BrowserAutomationActionResultV1Schema.parse({
                v: 1,
                automationRequestId: request.automationRequestId,
                status: 'succeeded',
                durationMs: 0,
                adapterKind: owner.adapterKind,
                fidelity: owner.fidelity,
                trustedInput: owner.trustedInput,
                navigationGenerationBefore: owner.navigationGeneration,
                navigationGenerationAfter: owner.navigationGeneration,
                controlEpochBefore: controller.controlEpoch,
                controlEpochAfter: controller.controlEpoch,
                resultSummary: {
                    controller: controller.controller,
                    controlEpoch: controller.controlEpoch,
                    ...(controller.activeAutomationRequestId ? { activeAutomationRequestId: controller.activeAutomationRequestId } : {}),
                },
            });
        },

        getSnapshot() {
            const ownerEntries = [...ownersByViewKey.entries()];
            const viewIdByViewKey = new Map(ownerEntries.map(([key, owner]) => [key, owner.viewId]));
            const viewIdCounts = new Map<string, number>();
            for (const [, owner] of ownerEntries) {
                viewIdCounts.set(owner.viewId, (viewIdCounts.get(owner.viewId) ?? 0) + 1);
            }
            const uniqueOwnerEntriesByViewId = ownerEntries.filter(([, owner]) => (
                viewIdCounts.get(owner.viewId) === 1
            ));
            const ownerSnapshot = ([key, owner]: readonly [string, BrowserAutomationOwner]) => ({
                key,
                viewKey: key,
                ownerId: owner.ownerId,
                authority: owner.authority,
                navigationGeneration: owner.navigationGeneration,
            });
            const controllerSnapshot = (
                key: string,
                controller: BrowserAutomationControllerState,
            ) => ({
                key,
                viewKey: key,
                controller: controller.controller,
                controlEpoch: controller.controlEpoch,
                activeAutomationRequestId: controller.activeAutomationRequestId,
                activeActionKind: controller.activeActionKind,
                activeTarget: controller.activeTarget,
                // An interrupted action keeps admission until its engine work settles; until then a
                // takeover has been asked for but has not landed.
                interruptionSettling: controller.activeAutomationRequestId !== null
                    && Boolean(activeActionsByRequestId.get(controller.activeAutomationRequestId)?.interruption),
            });
            return {
                ownersByViewId: Object.fromEntries(uniqueOwnerEntriesByViewId.map((entry) => [
                    entry[1].viewId,
                    ownerSnapshot(entry),
                ])),
                ownersByViewKey: Object.fromEntries(ownerEntries.map((entry) => [
                    entry[0],
                    ownerSnapshot(entry),
                ])),
                controllerByViewId: Object.fromEntries([...controllersByViewKey.entries()].flatMap(([key, controller]) => {
                    const viewId = viewIdByViewKey.get(key);
                    return viewId && viewIdCounts.get(viewId) === 1 ? [[viewId, controllerSnapshot(key, controller)]] : [];
                })),
                controllerByViewKey: Object.fromEntries([...controllersByViewKey.entries()].map(([key, controller]) => [
                    key,
                    controllerSnapshot(key, controller),
                ])),
            };
        },
    };
}
