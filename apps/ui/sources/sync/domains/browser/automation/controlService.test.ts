import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BrowserInjectedRuntimeResultMessageV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { describe, expect, it } from 'vitest';
import { createInjectedPageAutomationOwner } from '@/components/browser/adapters/automation/injectedPageRuntime';
import type {
    BrowserAutomationRequest as AutomationRequest,
    BrowserAutomationResult as AutomationResult,
    BrowserAutomationOwner as AutomationOwner,
} from './controlService';

type BrowserAutomationControlServiceModule = typeof import('./controlService');

async function loadControlServiceModule(): Promise<BrowserAutomationControlServiceModule | null> {
    return import('./controlService').catch(() => null);
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
    it('forwards an explicit dialog response to the injected owner and still permits a subsequent ordinary action', async () => {
        const { createBrowserAutomationControlService } = await import('./controlService');
        const service = createBrowserAutomationControlService({ nowMs: () => 1000 });
        const listeners = new Set<(raw: string) => void>();
        let pageEvaluations = 0;
        const ordinaryRequest = createRequest({ actionKind: 'click' });
        const dialogResponse = { kind: 'prompt', message: 'Enter a value', accept: true, promptText: 'Approved value' } as const;
        service.registerOwner(createInjectedPageAutomationOwner({
            ownerId: 'injected-owner',
            browserSessionId: ordinaryRequest.browserSessionId,
            viewId: ordinaryRequest.viewId,
            navigationGeneration: ordinaryRequest.navigationGeneration,
            adapterKind: 'localPreview',
            collectorId: 'collector',
            nonce: 'nonce',
            capabilityVersion: '1',
            supportedActions: ['click'],
            nowMs: () => 1000,
            transport: {
                subscribeToResults(listener) {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
                sendCommand(command) {
                    pageEvaluations++;
                    expect(command.payload.dialogResponse).toEqual(pageEvaluations === 1 ? dialogResponse : undefined);
                    const { commandName: _commandName, payload: _payload, ...identity } = command;
                    const result = BrowserInjectedRuntimeResultMessageV1Schema.parse({
                        ...identity,
                        kind: 'browser.injectedRuntime.result',
                        ok: true,
                        stale: false,
                        fidelity: 'injectedPage',
                        trusted: false,
                        durationMs: 1,
                        data: { clicked: true },
                    });
                    for (const listener of listeners) listener(JSON.stringify(result));
                },
            },
        }));

        const result = await service.executeAction({
            ...ordinaryRequest,
            dialogResponse,
        });
        expect(result).toMatchObject({ status: 'succeeded', resultSummary: { clicked: true } });
        expect(pageEvaluations).toBe(1);
        expect(service.getActionTimeline(ordinaryRequest)).toMatchObject([
            { status: 'succeeded' },
        ]);

        expect(await service.executeAction({ ...ordinaryRequest, automationRequestId: 'ordinary-after-dialog' }))
            .toMatchObject({ status: 'succeeded', resultSummary: { clicked: true } });
        expect(pageEvaluations).toBe(2);
    });
    it('retains equal admitted active targets while publishing actual motion and rejecting malformed targets', async () => {
        const { createBrowserAutomationControlService } = await import('./controlService');
        const service = createBrowserAutomationControlService({ nowMs: () => 1000 });
        const pending = createPendingResult();
        let report: Parameters<AutomationOwner['executeAction']>[1]['onActiveTarget'];
        service.registerOwner(createOwner({ executeAction: (_, context) => { report = context.onActiveTarget; return pending.promise; } }));
        const running = service.executeAction(createRequest({ actionKind: 'click' }));
        let notifications = 0;
        service.subscribe(() => { notifications++; });
        const target = { x: 0.2, y: 0.3, width: 0.1, height: 0.1, label: 'Button' };
        report!(target);
        expect(notifications).toBe(1);
        report!({ ...target });
        expect(notifications).toBe(1);
        report!({ ...target, x: -1 });
        expect(notifications).toBe(1);
        report!({ ...target, x: 0.4 });
        expect(notifications).toBe(2);
        pending.resolve({ status: 'succeeded' });
        expect(await running).toMatchObject({ status: 'succeeded' });
    });
    it('still cancels older work when a replacement owner already carries the current navigation generation', async () => {
        const { createBrowserAutomationControlService } = await import('./controlService');
        const pending = createPendingResult();
        const service = createBrowserAutomationControlService({ nowMs: () => 1000 });
        let notifications = 0;
        service.subscribe(() => { notifications++; });
        const owner = createOwner({ executeAction: () => pending.promise });
        service.registerOwner(owner);
        const running = service.executeAction(createRequest());
        service.registerOwner({ ...owner, navigationGeneration: 3 });
        service.updateNavigationGeneration({ browserSessionId: owner.browserSessionId, viewId: owner.viewId, navigationGeneration: 3 });
        const stalePublished = notifications;
        service.updateNavigationGeneration({ browserSessionId: owner.browserSessionId, viewId: owner.viewId, navigationGeneration: 3 });
        expect(notifications).toBe(stalePublished);
        pending.resolve({ status: 'succeeded' });
        expect(await running).toMatchObject({ status: 'stale', errorCode: 'stale_navigation' });
    });
    it('notifies on owner and navigation changes while retaining no-op control updates', async () => {
        const { createBrowserAutomationControlService } = await import('./controlService');
        const service = createBrowserAutomationControlService({ nowMs: () => 1000 });
        let notifications = 0;
        service.subscribe(() => { notifications++; });
        const owner = createOwner();
        const view = { browserSessionId: owner.browserSessionId, viewId: owner.viewId };
        expect(service.registerOwner(owner)).toEqual({ ok: true });
        expect(notifications).toBe(1);
        service.registerOwner(owner);
        service.updateNavigationGeneration({ ...view, navigationGeneration: owner.navigationGeneration });
        expect(notifications).toBe(1);
        service.updateNavigationGeneration({ ...view, navigationGeneration: owner.navigationGeneration + 1 });
        expect(notifications).toBe(2);
        service.recordHumanInput({ ...view, inputKind: 'pointer', occurredAtMs: 1000 });
        expect(notifications).toBe(3);
        service.recordHumanInput({ ...view, inputKind: 'pointer', occurredAtMs: 1001 });
        expect(notifications).toBe(3);
        expect(service.releaseHumanControl(view)).toBe(true);
        expect(notifications).toBe(4);
        expect(service.releaseHumanControl(view)).toBe(true);
        expect(notifications).toBe(4);
        // A new action remains observable even when only its timeline changes.
        const action = await service.executeAction(createRequest({ navigationGeneration: owner.navigationGeneration + 1 }));
        expect(action.status).toBe('succeeded');
        expect(notifications).toBeGreaterThan(4);
        expect(service.getActionTimeline(view)).toHaveLength(1);
        service.closeView(view);
        const closed = notifications;
        service.closeView(view);
        expect(notifications).toBe(closed);
    });
    it('retains UI admission until canceled engine work settles and reports uncertain acknowledgement', async () => {
        const { createBrowserAutomationControlService } = await import('./controlService');
        const pending = createPendingResult();
        const service = createBrowserAutomationControlService({ nowMs: () => 1000 });
        service.registerOwner(createOwner({ executeAction: () => pending.promise }));
        const action = service.executeAction(createRequest({ actionKind: 'click' }));
        const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' };
        expect(service.cancelActiveAction(view)).toMatchObject({ outcome: 'canceled', completion: 'uncertain' });
        expect(service.getStatus(createRequest())?.resultSummary).toMatchObject({ activeAutomationRequestId: 'automation_request_1', controller: 'human' });
        pending.resolve({ status: 'succeeded' });
        expect(await action).toMatchObject({ status: 'canceled', resultSummary: { completion: 'uncertain' } });
        expect(service.getStatus(createRequest())?.resultSummary).not.toHaveProperty('activeAutomationRequestId');
    });
    it('holds UI human control through explicit release and requires fresh observation', async () => {
        const { createBrowserAutomationControlService } = await import('./controlService');
        const service = createBrowserAutomationControlService({ nowMs: () => 1000 });
        // The registered engine boundary supplies deterministic page replies; admission stays real.
        service.registerOwner(createOwner());
        const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' };
        service.recordHumanInput({ ...view, inputKind: 'pointer', occurredAtMs: 1000 });
        expect(await service.executeAction(createRequest({ actionKind: 'click' }))).toMatchObject({ errorCode: 'human_interrupted' });
        service.releaseHumanControl(view);
        expect(await service.executeAction(createRequest({ actionKind: 'click' }))).toMatchObject({ errorCode: 'stale_navigation' });
        expect(await service.executeAction(createRequest())).toMatchObject({ status: 'succeeded' });
        expect(await service.executeAction(createRequest({ actionKind: 'click' }))).toMatchObject({ status: 'succeeded' });
    });
    it('registers one automation authority per view, rejects stale actions, and dispatches mutating ones', async () => {
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

        // R-1 at the UI owner: a mutating verb reaches the engine owner with nothing to acquire
        // first. This returned `policy_denied`/`lease_required` until the lease was removed.
        now += 1;
        const click = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_click',
            actionKind: 'click',
        }));
        expect(click.status).toBe('succeeded');
    });

    it('admits one mutating action per view and releases the view when it settles', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const pending = createPendingResult();
        const service = mod.createBrowserAutomationControlService({ nowMs: () => 1_500 });
        service.registerOwner(createOwner({
            executeAction: async () => pending.promise,
        }));

        const first = service.executeAction(createRequest({
            automationRequestId: 'automation_request_first_click',
            actionKind: 'click',
        }));
        await Promise.resolve();

        // Single-flight is the whole arbitration. It replaced a lease conflict check that could
        // never fire, because `acquireLease` had no caller anywhere in the product.
        const second = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_second_click',
            actionKind: 'click',
        }));
        expect(second).toMatchObject({
            status: 'policy_denied',
            errorCode: 'automation_busy',
        });

        pending.resolve({ status: 'succeeded' });
        await expect(first).resolves.toMatchObject({ status: 'succeeded' });

        const third = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_third_click',
            actionKind: 'click',
        }));
        expect(third.status).toBe('succeeded');
    });

    it('interrupts an in-flight agent action when a human takes over the view', async () => {
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
        const action = service.executeAction(createRequest({
            automationRequestId: 'automation_request_click_pending',
            actionKind: 'click',
        }));
        await Promise.resolve();
        expect(JSON.stringify(service.getSnapshot())).toContain('"controlEpoch":0');

        now += 20;
        service.recordHumanInput({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            inputKind: 'pointer',
            occurredAtMs: now,
        });

        pending.resolve({ status: 'succeeded' });
        const result = await action;
        expect(result).toMatchObject({
            status: 'interrupted',
            errorCode: 'human_interrupted',
        });
        expect(observedSignals[0]?.aborted).toBe(true);
        expect(JSON.stringify(service.getSnapshot())).toContain('"controlEpoch":1');
    });

    it('names the in-flight action on the controller snapshot so surfaces can narrate it', async () => {
        const mod = await loadControlServiceModule();
        if (!mod?.createBrowserAutomationControlService) throw new Error('control service missing');
        const pending = createPendingResult();
        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_000 });
        service.registerOwner(createOwner({ executeAction: async () => pending.promise }));
        const action = service.executeAction(createRequest({
            automationRequestId: 'automation_request_click_named',
            actionKind: 'click',
        }));
        await Promise.resolve();

        const controller = (service.getSnapshot().controllerByViewId as Record<string, Record<string, unknown>>)
            .browser_view_1;
        expect(controller).toMatchObject({ controller: 'agent', activeActionKind: 'click' });

        pending.resolve({ status: 'succeeded' });
        await action;
        expect((service.getSnapshot().controllerByViewId as Record<string, Record<string, unknown>>).browser_view_1)
            .toMatchObject({ controller: 'none', activeActionKind: null });
    });

    it.each([false, true])('cancels waitFor actions on navigation changes, owner disconnect, and view close (reopened: %s)', async (reopened) => {
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
        pendingNavigation.resolve({ status: 'succeeded' });
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
        pendingDisconnect.resolve({ status: 'succeeded' });
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
        // Retirement must survive eviction from the recent-closed-view projection while the
        // real engine action is still draining. 512 is the existing projection's boundary.
        for (let index = 0; index < 512; index += 1) {
            service.closeView({ browserSessionId: 'browser_session_1', viewId: `other_closed_${index}` });
        }
        if (reopened) {
            service.registerOwner(createOwner({ ownerId: 'owner_ui_reopened', navigationGeneration: 3 }));
        }
        pendingClose.resolve({ status: 'succeeded' });
        expect(await closeWait).toMatchObject({
            status: 'canceled',
            errorCode: 'view_closed',
        });
        const closedView = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' };
        expect(service.getActionTimeline(closedView)).toEqual([]);
        const key = viewKey(closedView.browserSessionId, closedView.viewId);
        if (reopened) {
            expect(service.getSnapshot().controllerByViewKey).toHaveProperty(key, expect.objectContaining({ controller: 'none' }));
        } else {
            expect(service.getSnapshot().controllerByViewKey).not.toHaveProperty(key);
        }
    });

    it('keeps admitted timeline entries without a second retention cutoff and preserves redaction', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const service = mod.createBrowserAutomationControlService({
            nowMs: () => 4_000,
        });
        service.registerOwner(createOwner());

        await service.executeAction(createRequest({
            automationRequestId: 'automation_request_snapshot_1',
            actionKind: 'snapshot',
        }));
        await service.executeAction(createRequest({
            automationRequestId: 'automation_request_type_1',
            actionKind: 'type',
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
        for (let index = 0; index < 498; index++) {
            await service.executeAction(createRequest({ automationRequestId: `retained_${index}` }));
        }

        const timeline = service.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
        });
        const serialized = JSON.stringify(timeline);

        expect(timeline).toHaveLength(501);
        expect(timeline[0]?.automationRequestId).toBe('automation_request_snapshot_1');
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

        // The tombstone set is bounded, so the oldest closed views are forgotten and degrade to
        // `owner_disconnected` while recent ones still report the precise `view_closed`.
        expect(await service.executeAction(createRequest({
            automationRequestId: 'automation_request_evicted_view',
            viewId: 'closed_view_0',
        }))).toMatchObject({ status: 'canceled', errorCode: 'owner_disconnected' });
        expect(await service.executeAction(createRequest({
            automationRequestId: 'automation_request_recent_closed_view',
            viewId: 'closed_view_519',
        }))).toMatchObject({ status: 'canceled', errorCode: 'view_closed' });
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

    it('does not let a system action displace an in-flight agent action on the same view', async () => {
        const mod = await loadControlServiceModule();

        expect(mod?.createBrowserAutomationControlService).toBeTypeOf('function');
        if (!mod?.createBrowserAutomationControlService) return;

        const pending = createPendingResult();
        const service = mod.createBrowserAutomationControlService({ nowMs: () => 4_900 });
        service.registerOwner(createOwner({
            executeAction: async () => pending.promise,
        }));

        const agentAction = service.executeAction(createRequest({
            automationRequestId: 'automation_request_agent_click',
            actionKind: 'click',
        }));
        await Promise.resolve();

        const result = await service.executeAction(createRequest({
            automationRequestId: 'automation_request_system_click',
            actionKind: 'click',
            requestedBy: 'system',
            requesterRef: { kind: 'system', id: 'scheduler' },
        }));

        expect(result).toMatchObject({ status: 'policy_denied', errorCode: 'automation_busy' });
        const snapshot = service.getSnapshot() as {
            controllerByViewKey?: Record<string, { controller?: string; activeAutomationRequestId?: string | null }>;
        };
        expect(snapshot.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toMatchObject({
            controller: 'agent',
            activeAutomationRequestId: 'automation_request_agent_click',
        });

        pending.resolve({ status: 'succeeded' });
        await expect(agentAction).resolves.toMatchObject({ status: 'succeeded' });
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

        // A read-only snapshot does not claim mutation admission or displace its controller.
        const snapshotAction = service.executeAction(createRequest({
            automationRequestId: 'automation_request_system_snapshot',
            actionKind: 'snapshot',
            requestedBy: 'system',
            requesterRef: { kind: 'system', id: 'observer' },
        }));
        await Promise.resolve();

        const snapshotWhilePending = service.getSnapshot() as {
            controllerByViewKey?: Record<string, { controller?: string; activeAutomationRequestId?: string | null }>;
        };
        expect(snapshotWhilePending.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toMatchObject({
            controller: 'none',
            activeAutomationRequestId: null,
        });

        pending.resolve({ status: 'succeeded' });
        await expect(snapshotAction).resolves.toMatchObject({ status: 'succeeded' });

        const snapshotAfterFinish = service.getSnapshot() as {
            controllerByViewKey?: Record<string, { controller?: string; activeAutomationRequestId?: string | null }>;
        };
        expect(snapshotAfterFinish.controllerByViewKey?.[viewKey('browser_session_1', 'browser_view_1')]).toMatchObject({
            controller: 'none',
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
            actionKind: 'click',
        }));
        await Promise.resolve();

        expect(notifications.some((snapshot) => snapshot.includes('automation_request_wait_cancel'))).toBe(true);

        const canceled = service.cancelActiveAction({
            browserSessionId: 'browser_session_1',
            viewId: 'browser_view_1',
            reasonCode: 'user_canceled',
        });
        expect(canceled).toEqual({ v: 1, outcome: 'canceled', canceledCount: 1, completion: 'uncertain' });
        pending.resolve({ status: 'succeeded' });
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
