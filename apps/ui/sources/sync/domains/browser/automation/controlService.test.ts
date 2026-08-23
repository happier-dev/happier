import { browserViewKey } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

type AutomationRequest = Readonly<{
    v: 1;
    automationRequestId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    requestedBy: 'agent' | 'plugin' | 'system' | 'user';
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

type AutomationResult = Readonly<{
    status: string;
    errorCode?: string;
    resultSummary?: Readonly<Record<string, unknown>>;
}>;

type AutomationCancelActiveResult =
    | Readonly<{ v: 1; outcome: 'canceled'; canceledCount: number }>
    | Readonly<{ v: 1; outcome: 'no_active' | 'owner_mismatch'; canceledCount: 0 }>;

type AutomationOwner = Readonly<{
    ownerId: string;
    authority: 'uiLocal' | 'daemon' | 'serverBroker';
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    adapterKind: string;
    fidelity: string;
    trustedInput: boolean;
    supportedActions: readonly string[];
    executeAction: (
        request: AutomationRequest,
        context: Readonly<{ signal: AbortSignal }>,
    ) => Promise<AutomationResult>;
}>;

type BrowserAutomationControlService = Readonly<{
    registerOwner: (owner: AutomationOwner) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
    unregisterOwner: (input: Readonly<{ ownerId: string; reasonCode: string }>) => void;
    closeView: (input: Readonly<{ browserSessionId: string; viewId: string }>) => void;
    updateNavigationGeneration: (
        input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number }>,
    ) => void;
    acquireLease: (
        input: Readonly<{
            browserSessionId: string;
            viewId: string;
            requestedBy: 'agent' | 'plugin' | 'system' | 'user';
            requesterRef: Readonly<{ kind: string; id: string }>;
            ttlMs: number;
        }>,
    ) => Readonly<{ ok: true; leaseId: string; controlEpoch: number } | { ok: false; result: AutomationResult }>;
    executeAction: (request: AutomationRequest) => Promise<AutomationResult>;
    cancelActiveAction: (
        input: Readonly<{ browserSessionId: string; viewId: string; reasonCode?: string }>,
    ) => AutomationCancelActiveResult;
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
    ) => readonly Readonly<Record<string, unknown>>[];
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => Readonly<Record<string, unknown>>;
}>;

type BrowserAutomationControlServiceModule = Readonly<{
    createBrowserAutomationControlService?: (
        input: Readonly<{ nowMs: () => number; maxTimelineEntries?: number }>,
    ) => BrowserAutomationControlService;
}>;

async function loadControlServiceModule(): Promise<BrowserAutomationControlServiceModule | null> {
    const path = './controlService';
    return import(path).catch(() => null) as Promise<BrowserAutomationControlServiceModule | null>;
}

function createOwner(overrides: Partial<AutomationOwner> = {}): AutomationOwner {
    return {
        ownerId: 'owner_ui_1',
        authority: 'uiLocal',
        browserSessionId: 'browser_session_1',
        viewId: 'browser_view_1',
        navigationGeneration: 2,
        adapterKind: 'localPreview',
        fidelity: 'injectedPage',
        trustedInput: false,
        supportedActions: ['snapshot', 'click', 'type', 'waitFor'],
        executeAction: async () => ({ status: 'succeeded' }),
        ...overrides,
    };
}

function viewKey(browserSessionId: string, viewId: string): string {
    return browserViewKey({ browserSessionId, viewId });
}

function createRequest(overrides: Partial<AutomationRequest> = {}): AutomationRequest {
    return {
        v: 1,
        automationRequestId: 'automation_request_1',
        browserSessionId: 'browser_session_1',
        viewId: 'browser_view_1',
        navigationGeneration: 2,
        requestedBy: 'agent',
        requesterRef: {
            kind: 'session',
            id: 'session_1',
        },
        actionKind: 'snapshot',
        timeoutMs: 1_000,
        ...overrides,
    };
}

function createPendingResult(): Readonly<{
    promise: Promise<AutomationResult>;
    resolve: (result: AutomationResult) => void;
}> {
    let resolvePending: (result: AutomationResult) => void = () => undefined;
    const promise = new Promise<AutomationResult>((resolve) => {
        resolvePending = resolve;
    });
    return {
        promise,
        resolve: resolvePending,
    };
}

describe('browser automation control service', () => {
    it('registers one automation authority per view and rejects stale or lease-less mutating actions', async () => {
        let now = 1_000;
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => now });
        expect(service.registerOwner(createOwner())).toEqual({ ok: true });
        expect(service.registerOwner(createOwner({
            ownerId: 'owner_daemon_1',
            authority: 'daemon',
        }))).toEqual({
            ok: false,
            reasonCode: 'owner_conflict',
        });

        const snapshot = await service.executeAction(createRequest());
        expect(snapshot.status).toBe('succeeded');

        const stale = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_stale',
            navigationGeneration: 1,
        }));
        expect(stale).toMatchObject({
            status: 'stale',
            errorCode: 'stale_navigation',
        });

        const clickWithoutLease = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_click',
            actionKind: 'click',
        }));
        expect(clickWithoutLease).toMatchObject({
            status: 'policy_denied',
            errorCode: 'lease_required',
        });

        const lease = service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            requestedBy: 'agent',
            requesterRef: {
                kind: 'session',
                id: 'session_1',
            },
            ttlMs: 1_000,
        });
        expect(lease).toMatchObject({
            ok: true,
            controlEpoch: 0,
        });
        if (!lease.ok) return;

        now += 1;
        const click = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_click_with_lease',
            actionKind: 'click',
            leaseId: lease.leaseId,
            expectedControlEpoch: lease.controlEpoch,
        }));
        expect(click.status).toBe('succeeded');
    });

    it('lets expected synthetic input pass but interrupts agent actions on human input', async () => {
        let now = 2_000;
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const pending = createPendingResult();
        const observedSignals: AbortSignal[] = [];
        const service = mod.createBrowserAutomationControlService({ nowMs: () => now });
        service.registerOwner(createOwner({
            executeAction: async (_request, context) => {
                observedSignals.push(context.signal);
                return pending.promise;
            },
        }));
        const lease = service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            requestedBy: 'agent',
            requesterRef: {
                kind: 'session',
                id: 'session_1',
            },
            ttlMs: 1_000,
        });
        expect(lease).toMatchObject({ ok: true });
        if (!lease.ok) return;

        const action = service.executeAction(createRequest({
            automationRequestId: 'automation_request_click_pending',
            actionKind: 'click',
            leaseId: lease.leaseId,
            expectedControlEpoch: lease.controlEpoch,
            expectedSyntheticInputWindowMs: 100,
        }));
        await Promise.resolve();

        service.recordSyntheticInput({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            automationRequestId: 'automation_request_click_pending',
            inputKind: 'pointer',
            occurredAtMs: now + 10,
        });
        expect(JSON.stringify(service.getSnapshot())).toContain('"controlEpoch":0');

        now += 20;
        service.recordHumanInput({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            inputKind: 'pointer',
            occurredAtMs: now,
        });

        const result = await action;
        expect(result).toMatchObject({
            status: 'interrupted',
            errorCode: 'human_interrupted',
        });
        expect(observedSignals[0]?.aborted).toBe(true);
        expect(JSON.stringify(service.getSnapshot())).toContain('"controlEpoch":1');
    });

    it('cancels waitFor actions on navigation changes, owner disconnect, and view close', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => 3_000 });
        const pendingNavigation = createPendingResult();
        service.registerOwner(createOwner({
            executeAction: async () => pendingNavigation.promise,
        }));

        const navigationWait = service.executeAction(createRequest({
            automationRequestId: 'automation_request_wait_navigation',
            actionKind: 'waitFor',
            payload: {
                condition: 'selector',
                selector: '#ready',
            },
        }));
        await Promise.resolve();
        service.updateNavigationGeneration({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            navigationGeneration: 3,
        });
        expect(await navigationWait).toMatchObject({
            status: 'stale',
            errorCode: 'stale_navigation',
        });
        service.unregisterOwner({
            ownerId: 'owner_ui_1',
            reasonCode: 'owner_disconnected',
        });

        const pendingDisconnect = createPendingResult();
        service.registerOwner(createOwner({
            ownerId: 'owner_ui_2',
            navigationGeneration: 3,
            executeAction: async () => pendingDisconnect.promise,
        }));
        const disconnectWait = service.executeAction(createRequest({
            automationRequestId: 'automation_request_wait_disconnect',
            actionKind: 'waitFor',
            navigationGeneration: 3,
        }));
        await Promise.resolve();
        service.unregisterOwner({
            ownerId: 'owner_ui_2',
            reasonCode: 'owner_disconnected',
        });
        expect(await disconnectWait).toMatchObject({
            status: 'canceled',
            errorCode: 'owner_disconnected',
        });

        const pendingClose = createPendingResult();
        service.registerOwner(createOwner({
            ownerId: 'owner_ui_3',
            navigationGeneration: 3,
            executeAction: async () => pendingClose.promise,
        }));
        const closeWait = service.executeAction(createRequest({
            automationRequestId: 'automation_request_wait_close',
            actionKind: 'waitFor',
            navigationGeneration: 3,
        }));
        await Promise.resolve();
        service.closeView({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        });
        expect(await closeWait).toMatchObject({
            status: 'canceled',
            errorCode: 'view_closed',
        });
    });

    it('keeps the action timeline bounded and redacted', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({
            nowMs: () => 4_000,
            maxTimelineEntries: 2,
        });
        service.registerOwner(createOwner());
        const lease = service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            requestedBy: 'agent',
            requesterRef: {
                kind: 'session',
                id: 'session_1',
            },
            ttlMs: 1_000,
        });
        expect(lease).toMatchObject({ ok: true });
        if (!lease.ok) return;

        await service.executeAction(createRequest({
            automationRequestId: 'automation_request_snapshot_1',
            actionKind: 'snapshot',
        }));
        await service.executeAction(createRequest({
            automationRequestId: 'automation_request_type_1',
            actionKind: 'type',
            leaseId: lease.leaseId,
            expectedControlEpoch: lease.controlEpoch,
            payload: {
                selector: '#password',
                text: 'hunter2',
                password: 'secret',
            },
        }));
        await service.executeAction(createRequest({
            automationRequestId: 'automation_request_wait_1',
            actionKind: 'waitFor',
        }));

        const timeline = service.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        });
        const serialized = JSON.stringify(timeline);

        expect(timeline).toHaveLength(2);
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('password');
        expect(serialized).not.toContain('data:image');
        expect(serialized).toContain('automation_request_wait_1');
    });

    it('prunes controller and timeline state when a view closes and bounds closed-view tombstones', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_500 });
        service.registerOwner(createOwner());
        await service.executeAction(createRequest({ automationRequestId: 'automation_request_snapshot_before_close' }));

        service.closeView({ browserSessionId: 'browser_session_1', viewId: 'browser_view_1' });

        expect(service.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        })).toEqual([]);
        const snapshot = service.getSnapshot() as {
            controllerByViewKey?: Record<string, unknown>;
        };
        expect(snapshot.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toBeUndefined();

        for (let index = 0; index < 520; index += 1) {
            service.closeView({
                browserSessionId: 'browser_session_1',
                viewId: `closed_view_${index}`,
            });
        }

        expect(service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'closed_view_0',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        })).toMatchObject({
            ok: false,
            result: { errorCode: 'owner_disconnected' },
        });
        expect(service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'closed_view_519',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        })).toMatchObject({
            ok: false,
            result: { errorCode: 'view_closed' },
        });
    });

    it('preserves known automation error codes from owner rejections and records the redacted raw failure', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_750 });
        service.registerOwner(createOwner({
            executeAction: async () => {
                throw { errorCode: 'selector_not_found', message: 'missing #submit', token: 'secret-token' };
            },
        }));

        const result = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_rejected',
        }));

        expect(result).toMatchObject({ status: 'failed', errorCode: 'selector_not_found' });
        const lastEntry = service.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        }).at(-1) as { resultSummary?: unknown; reasonCode?: string } | undefined;

        expect(lastEntry?.reasonCode).toBe('selector_not_found');
        expect(lastEntry?.resultSummary).toMatchObject({
            status: 'failed',
            errorCode: 'selector_not_found',
            rawFailure: {
                errorCode: 'selector_not_found',
                message: 'missing #submit',
            },
        });
        expect(JSON.stringify(lastEntry?.resultSummary)).not.toContain('secret-token');
    });

    it('does not let a system action consume an agent lease or clear the agent controller', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_900 });
        service.registerOwner(createOwner());
        const lease = service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        });
        expect(lease).toMatchObject({ ok: true });
        if (!lease.ok) return;

        const result = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_system_wrong_lease',
            actionKind: 'click',
            requestedBy: 'system',
            requesterRef: { kind: 'system', id: 'scheduler' },
            leaseId: lease.leaseId,
            expectedControlEpoch: lease.controlEpoch,
        }));

        expect(result).toMatchObject({ status: 'policy_denied', errorCode: 'owner_mismatch' });
        const snapshot = service.getSnapshot() as {
            controllerByViewKey?: Record<string, { controller?: string; activeLeaseId?: string | null }>;
        };
        expect(snapshot.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toMatchObject({
            controller: 'agent',
            activeLeaseId: lease.leaseId,
        });
    });

    it('keeps an agent controller claim when a system snapshot finishes concurrently', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const pending = createPendingResult();
        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_925 });
        service.registerOwner(createOwner({
            executeAction: async () => pending.promise,
        }));
        const lease = service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        });
        expect(lease).toMatchObject({ ok: true });
        if (!lease.ok) return;

        const snapshotAction = service.executeAction(createRequest({
            automationRequestId: 'automation_request_system_snapshot',
            actionKind: 'snapshot',
            requestedBy: 'system',
            requesterRef: { kind: 'system', id: 'observer' },
        }));
        await Promise.resolve();

        const snapshotWhilePending = service.getSnapshot() as {
            controllerByViewKey?: Record<string, { controller?: string; activeLeaseId?: string | null; activeAutomationRequestId?: string | null }>;
        };
        expect(snapshotWhilePending.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toMatchObject({
            controller: 'agent',
            activeLeaseId: lease.leaseId,
            activeAutomationRequestId: 'automation_request_system_snapshot',
        });

        pending.resolve({ status: 'succeeded' });
        await expect(snapshotAction).resolves.toMatchObject({ status: 'succeeded' });

        const snapshotAfterFinish = service.getSnapshot() as {
            controllerByViewKey?: Record<string, { controller?: string; activeLeaseId?: string | null; activeAutomationRequestId?: string | null }>;
        };
        expect(snapshotAfterFinish.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toMatchObject({
            controller: 'agent',
            activeLeaseId: lease.leaseId,
            activeAutomationRequestId: null,
        });
    });

    it('snapshots controllers by concrete view key without unknown-key collisions', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_950 });
        service.registerOwner(createOwner({
            ownerId: 'owner_one',
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        }));
        service.registerOwner(createOwner({
            ownerId: 'owner_two',
            browserSessionId: 'browser_session_2',
            viewId: 'browser_view_2',
        }));
        service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        });
        service.acquireLease({
            browserSessionId: 'browser_session_2',
            viewId: 'browser_view_2',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_2' },
            ttlMs: 1_000,
        });

        const snapshot = service.getSnapshot() as {
            controllerByViewKey?: Record<string, unknown>;
        };

        expect(Object.keys(snapshot.controllerByViewKey ?? {}).sort()).toEqual([
            viewKey('browser_session_1', 'browser_view_1'),
            viewKey('browser_session_2', 'browser_view_2'),
        ]);
        expect(JSON.stringify(snapshot)).not.toContain('"unknown"');
    });

    it('omits ambiguous legacy view-id snapshot entries when sessions reuse a view id', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_975 });
        service.registerOwner(createOwner({
            ownerId: 'owner_one',
            browserSessionId: 'browser_session_1',
            viewId: 'shared_view',
        }));
        service.registerOwner(createOwner({
            ownerId: 'owner_two',
            browserSessionId: 'browser_session_2',
            viewId: 'shared_view',
        }));
        const firstLease = service.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'shared_view',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        });
        const secondLease = service.acquireLease({
            browserSessionId: 'browser_session_2',
            viewId: 'shared_view',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_2' },
            ttlMs: 1_000,
        });
        expect(firstLease).toMatchObject({ ok: true });
        expect(secondLease).toMatchObject({ ok: true });

        const snapshot = service.getSnapshot() as {
            ownersByViewId?: Record<string, unknown>;
            ownersByViewKey?: Record<string, unknown>;
            controllerByViewId?: Record<string, unknown>;
            controllerByViewKey?: Record<string, unknown>;
        };

        expect(snapshot.ownersByViewKey?.[viewKey('browser_session_1', 'shared_view')]).toBeDefined();
        expect(snapshot.ownersByViewKey?.[viewKey('browser_session_2', 'shared_view')]).toBeDefined();
        expect(snapshot.controllerByViewKey?.[viewKey('browser_session_1', 'shared_view')]).toBeDefined();
        expect(snapshot.controllerByViewKey?.[viewKey('browser_session_2', 'shared_view')]).toBeDefined();
        expect(snapshot.ownersByViewId?.shared_view).toBeUndefined();
        expect(snapshot.controllerByViewId?.shared_view).toBeUndefined();
    });

    it('notifies product surfaces and lets them cancel an active automation action', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const pending = createPendingResult();
        const observedSignals: AbortSignal[] = [];
        const service = mod.createBrowserAutomationControlService({ nowMs: () => 5_000 });
        const notifications: string[] = [];
        const unsubscribe = service.subscribe(() => {
            notifications.push(JSON.stringify(service.getSnapshot()));
        });

        service.registerOwner(createOwner({
            executeAction: async (_request, context) => {
                observedSignals.push(context.signal);
                return pending.promise;
            },
        }));
        const action = service.executeAction(createRequest({
            automationRequestId: 'automation_request_wait_cancel',
            actionKind: 'waitFor',
        }));
        await Promise.resolve();

        expect(notifications.some((snapshot) => snapshot.includes('automation_request_wait_cancel'))).toBe(true);

        const canceled = service.cancelActiveAction({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            reasonCode: 'user_canceled',
        });
        expect(canceled).toEqual({ v: 1, outcome: 'canceled', canceledCount: 1 });

        await expect(action).resolves.toMatchObject({
            status: 'canceled',
            errorCode: 'user_canceled',
        });
        expect(observedSignals[0]?.aborted).toBe(true);
        expect(service.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        }).at(-1)).toMatchObject({
            automationRequestId: 'automation_request_wait_cancel',
            status: 'canceled',
            reasonCode: 'user_canceled',
        });

        unsubscribe();
        service.registerOwner(createOwner({ ownerId: 'owner_ui_after_unsubscribe' }));
        const notificationCountAfterUnsubscribe = notifications.length;
        const noActive = service.cancelActiveAction({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        });
        expect(noActive).toEqual({ v: 1, outcome: 'no_active', canceledCount: 0 });
        expect(notifications).toHaveLength(notificationCountAfterUnsubscribe);
    });
});
