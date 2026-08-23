import {
    browserViewKey,
    BrowserAutomationCancelActiveResultV1Schema,
    BrowserAutomationErrorCodeV1Schema,
    redactBrowserAutomationTimelineDetails,
    type BrowserAutomationCancelActiveResultV1,
    type BrowserAutomationErrorCodeV1,
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
    errorCode?: BrowserAutomationErrorCodeV1;
    automationRequestId?: string;
    durationMs?: number;
    resultSummary?: Readonly<Record<string, unknown>>;
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
        context: Readonly<{ signal: AbortSignal }>,
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
    executeAction: (request: BrowserAutomationRequest) => Promise<BrowserAutomationResult>;
    cancelActiveAction: (
        input: Readonly<{ browserSessionId: string; viewId: string; reasonCode?: BrowserAutomationErrorCodeV1 }>,
    ) => BrowserAutomationCancelActiveResultV1;
    recordHumanInput: (
        input: Readonly<{ browserSessionId: string; viewId: string; inputKind: string; occurredAtMs: number }>,
    ) => void;
    getActionTimeline: (
        input: Readonly<{ browserSessionId: string; viewId: string }>,
    ) => readonly BrowserAutomationTimelineEntry[];
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => Readonly<Record<string, unknown>>;
}>;

const MUTATING_ACTIONS = new Set([
    'navigate',
    'reload',
    'goBack',
    'goForward',
    'click',
    'tap',
    'type',
    'press',
    'scroll',
    'hover',
    'focus',
    'select',
    'setValue',
    'upload',
    'drag',
    'evaluate',
    'startElementPicker',
    'cancelElementPicker',
]);
const CLOSED_VIEW_KEY_LIMIT = 512;

function isMutatingAction(actionKind: string): boolean {
    return MUTATING_ACTIONS.has(actionKind);
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
        };
        controllersByViewKey.set(viewKey, next);
        return next;
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
        active.settled = true;
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
            // A human takeover owns the view until the next action; only an agent/system action
            // releases the controller back to `none` when it finishes.
            if (controller.controller !== 'human') {
                controller.controller = 'none';
            }
        }
        appendTimeline(active, result);
        active.resolve({
            ...result,
            automationRequestId: active.request.automationRequestId,
            durationMs: Math.max(0, now() - active.startedAtMs),
        });
        emitChange();
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
            finishActiveAction(active, { status, errorCode });
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
        return unavailableResult(status, errorCode);
    }

    /**
     * Single-flight admission for a mutating action: at most one runs per view. This is the whole
     * arbitration. It replaced a lease that no caller could mint, so the check it nominally
     * performed never actually ran — this one does, on the real dispatch path.
     */
    function admitMutatingAction(request: BrowserAutomationRequest): BrowserAutomationResult | null {
        if (!isMutatingAction(request.actionKind)) return null;
        const controller = controllerFor(browserViewKey(request));
        if (!controller.activeAutomationRequestId) return null;
        if (controller.activeAutomationRequestId === request.automationRequestId) return null;
        return unavailableResult('policy_denied', 'automation_busy');
    }

    function handleHumanInput(inputValue: Readonly<{
        browserSessionId: string;
        viewId: string;
        occurredAtMs: number;
    }>): void {
        const viewKey = browserViewKey(inputValue);
        const controller = controllerFor(viewKey);
        controller.controlEpoch += 1;
        controller.controller = 'human';
        cancelActiveActionsForView(viewKey, 'interrupted', 'human_interrupted', (active) => (
            isMutatingAction(active.request.actionKind)
            && active.request.requestedBy === 'agent'
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
            cancelActiveActionsForView(viewKey, 'canceled', 'view_closed');
            controllersByViewKey.delete(viewKey);
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

        executeAction(request) {
            const viewKey = browserViewKey(request);
            const owner = ownersByViewKey.get(viewKey) ?? null;
            if (closedViewKeys.has(viewKey)) {
                return Promise.resolve(rejectAndRecord(request, owner, 'canceled', 'view_closed'));
            }
            if (!owner) {
                return Promise.resolve(unavailableResult('canceled', 'owner_disconnected'));
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
            controller.activeAutomationRequestId = request.automationRequestId;
            controller.activeRequesterRef = request.requesterRef;
            if (isMutatingAction(request.actionKind)) {
                controller.controller = request.requestedBy === 'system' ? 'system' : 'agent';
            }
            emitChange();
            active.timeoutId = setTimeout(() => {
                finishActiveAction(active, { status: 'timed_out', errorCode: 'timed_out' });
            }, request.timeoutMs);

            owner.executeAction(request, { signal: abortController.signal }).then((result) => {
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
            return BrowserAutomationCancelActiveResultV1Schema.parse(
                canceledCount > 0
                    ? { v: 1, outcome: 'canceled', canceledCount }
                    : { v: 1, outcome: 'no_active', canceledCount: 0 },
            );
        },

        recordHumanInput(inputValue) {
            handleHumanInput(inputValue);
            emitChange();
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
