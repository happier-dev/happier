import {
    BrowserAutomationErrorCodeV1Schema,
    redactBrowserAutomationTimelineDetails,
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
    leaseId?: string;
    expectedControlEpoch?: number;
    expectedSyntheticInputWindowMs?: number;
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

type BrowserAutomationLease = Readonly<{
    leaseId: string;
    viewKey: string;
    requestedBy: BrowserAutomationRequesterKind;
    requesterRef: Readonly<{ kind: string; id: string }>;
    controlEpoch: number;
    acquiredAtMs: number;
    expiresAtMs: number;
}>;

type BrowserAutomationControllerState = {
    controller: 'none' | 'human' | 'agent' | 'system';
    controlEpoch: number;
    activeLeaseId: string | null;
    activeAutomationRequestId: string | null;
};

type ActiveAction = {
    request: BrowserAutomationRequest;
    owner: BrowserAutomationOwner;
    abortController: AbortController;
    queuedAtMs: number;
    startedAtMs: number;
    controlEpochBefore: number;
    navigationGenerationBefore: number;
    expectedSyntheticUntilMs: number;
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
    acquireLease: (
        input: Readonly<{
            browserSessionId: string;
            viewId: string;
            requestedBy: BrowserAutomationRequesterKind;
            requesterRef: Readonly<{ kind: string; id: string }>;
            ttlMs: number;
        }>,
    ) => Readonly<{ ok: true; leaseId: string; controlEpoch: number } | { ok: false; result: BrowserAutomationResult }>;
    executeAction: (request: BrowserAutomationRequest) => Promise<BrowserAutomationResult>;
    cancelActiveAction: (
        input: Readonly<{ browserSessionId: string; viewId: string; reasonCode?: BrowserAutomationErrorCodeV1 }>,
    ) => void;
    recordHumanInput: (
        input: Readonly<{ browserSessionId: string; viewId: string; inputKind: string; occurredAtMs: number }>,
    ) => void;
    recordSyntheticInput: (
        input: Readonly<{
            browserSessionId: string;
            viewId: string;
            automationRequestId: string;
            inputKind: string;
            occurredAtMs: number;
        }>,
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
    'evaluate',
    'startElementPicker',
    'cancelElementPicker',
]);
const CLOSED_VIEW_KEY_LIMIT = 512;

function viewKeyFor(input: Readonly<{ browserSessionId: string; viewId: string }>): string {
    return `${input.browserSessionId}:${input.viewId}`;
}

function isMutatingAction(actionKind: string): boolean {
    return MUTATING_ACTIONS.has(actionKind);
}

function unavailableResult(status: BrowserAutomationResultStatus, errorCode: BrowserAutomationErrorCodeV1): BrowserAutomationResult {
    return { status, errorCode };
}

function requesterMatches(
    a: Readonly<{ kind: string; id: string }>,
    b: Readonly<{ kind: string; id: string }>,
): boolean {
    return a.kind === b.kind && a.id === b.id;
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
    let nextLeaseSeq = 0;
    let nextTimelineSeq = 0;
    const ownersByViewKey = new Map<string, BrowserAutomationOwner>();
    const ownerIdToViewKey = new Map<string, string>();
    const controllersByViewKey = new Map<string, BrowserAutomationControllerState>();
    const leasesById = new Map<string, BrowserAutomationLease>();
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
            activeLeaseId: null,
            activeAutomationRequestId: null,
        };
        controllersByViewKey.set(viewKey, next);
        return next;
    }

    function appendTimeline(active: ActiveAction, result: BrowserAutomationResult): void {
        const viewKey = viewKeyFor(active.request);
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
        const viewKey = viewKeyFor(active.request);
        const controller = controllerFor(viewKey);
        const finishingLeaseStillActive = Boolean(
            active.request.leaseId && controller.activeLeaseId === active.request.leaseId,
        );
        if (controller.activeAutomationRequestId === active.request.automationRequestId) {
            controller.activeAutomationRequestId = null;
        }
        if (isMutatingAction(active.request.actionKind)) {
            if (active.request.leaseId && finishingLeaseStillActive) {
                leasesById.delete(active.request.leaseId);
            }
            if (finishingLeaseStillActive) {
                controller.activeLeaseId = null;
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
    ): void {
        for (const active of [...activeActionsByRequestId.values()]) {
            if (viewKeyFor(active.request) !== viewKey || !predicate(active)) continue;
            finishActiveAction(active, { status, errorCode });
        }
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
            controlEpochBefore: controllerFor(viewKeyFor(request)).controlEpoch,
            navigationGenerationBefore: owner.navigationGeneration,
            expectedSyntheticUntilMs: 0,
            settled: false,
            timeoutId: null,
            resolve: () => undefined,
        };
        appendTimeline(syntheticActive, { status, errorCode });
        return unavailableResult(status, errorCode);
    }

    function validateLease(request: BrowserAutomationRequest): BrowserAutomationResult | null {
        if (!isMutatingAction(request.actionKind)) return null;
        if (!request.leaseId) return unavailableResult('policy_denied', 'lease_required');
        const lease = leasesById.get(request.leaseId);
        const viewKey = viewKeyFor(request);
        if (!lease || lease.viewKey !== viewKey) return unavailableResult('policy_denied', 'lease_required');
        if (lease.expiresAtMs < now()) {
            leasesById.delete(request.leaseId);
            return unavailableResult('policy_denied', 'lease_expired');
        }
        if (lease.requestedBy !== request.requestedBy || !requesterMatches(lease.requesterRef, request.requesterRef)) {
            return unavailableResult('policy_denied', 'owner_mismatch');
        }
        const controller = controllerFor(viewKey);
        if (request.expectedControlEpoch !== undefined && request.expectedControlEpoch !== controller.controlEpoch) {
            return unavailableResult('stale', 'control_epoch_mismatch');
        }
        return null;
    }

    function handleHumanInput(inputValue: Readonly<{
        browserSessionId: string;
        viewId: string;
        occurredAtMs: number;
    }>): void {
        const viewKey = viewKeyFor(inputValue);
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
            const viewKey = viewKeyFor(owner);
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
            const viewKey = viewKeyFor(inputValue);
            closedViewKeys.add(viewKey);
            const owner = ownersByViewKey.get(viewKey);
            if (owner) {
                ownerIdToViewKey.delete(owner.ownerId);
            }
            ownersByViewKey.delete(viewKey);
            leasesById.forEach((lease, leaseId) => {
                if (lease.viewKey === viewKey) leasesById.delete(leaseId);
            });
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
            const viewKey = viewKeyFor(inputValue);
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

        acquireLease(request) {
            const viewKey = viewKeyFor(request);
            const owner = ownersByViewKey.get(viewKey);
            if (closedViewKeys.has(viewKey)) {
                return { ok: false, result: unavailableResult('canceled', 'view_closed') };
            }
            if (!owner) {
                return { ok: false, result: unavailableResult('canceled', 'owner_disconnected') };
            }
            const controller = controllerFor(viewKey);
            if (controller.activeLeaseId || controller.activeAutomationRequestId) {
                return { ok: false, result: unavailableResult('policy_denied', 'lease_conflict') };
            }
            nextLeaseSeq += 1;
            const leaseId = `browser_automation_lease:${nextLeaseSeq}`;
            const lease: BrowserAutomationLease = {
                leaseId,
                viewKey,
                requestedBy: request.requestedBy,
                requesterRef: request.requesterRef,
                controlEpoch: controller.controlEpoch,
                acquiredAtMs: now(),
                expiresAtMs: now() + Math.max(1, request.ttlMs),
            };
            leasesById.set(leaseId, lease);
            controller.activeLeaseId = leaseId;
            controller.controller = request.requestedBy === 'system' ? 'system' : 'agent';
            emitChange();
            return {
                ok: true,
                leaseId,
                controlEpoch: controller.controlEpoch,
            };
        },

        executeAction(request) {
            const viewKey = viewKeyFor(request);
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
            const leaseError = validateLease(request);
            if (leaseError) {
                return Promise.resolve(rejectAndRecord(request, owner, leaseError.status, leaseError.errorCode ?? 'policy_denied'));
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
                expectedSyntheticUntilMs: now() + (request.expectedSyntheticInputWindowMs ?? 0),
                settled: false,
                timeoutId: null,
                resolve: () => undefined,
            };

            const resultPromise = new Promise<BrowserAutomationResult>((resolve) => {
                active.resolve = resolve;
            });
            activeActionsByRequestId.set(request.automationRequestId, active);
            controller.activeAutomationRequestId = request.automationRequestId;
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
            cancelActiveActionsForView(
                viewKeyFor(inputValue),
                'canceled',
                inputValue.reasonCode ?? 'user_canceled',
            );
        },

        recordHumanInput(inputValue) {
            handleHumanInput(inputValue);
            emitChange();
        },

        recordSyntheticInput(inputValue) {
            const active = activeActionsByRequestId.get(inputValue.automationRequestId);
            if (!active) return;
            if (viewKeyFor(active.request) !== viewKeyFor(inputValue)) return;
            if (inputValue.occurredAtMs <= active.expectedSyntheticUntilMs) {
                return;
            }
            handleHumanInput(inputValue);
        },

        getActionTimeline(inputValue) {
            return [...(timelineByViewKey.get(viewKeyFor(inputValue)) ?? [])];
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
                activeLeaseId: controller.activeLeaseId,
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
