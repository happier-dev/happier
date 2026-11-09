import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { describe, expect, it } from 'vitest';

import { createBrowserAutomationControlService, type BrowserAutomationResult } from './controlService';
import { readBrowserAgentPoint, selectBrowserAgentPoint, selectBrowserCopresence } from './copresence';

const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } as const;

function setup() {
    const service = createBrowserAutomationControlService({ nowMs: () => 1_000 });
    let resolve: (result: BrowserAutomationResult) => void = () => undefined;
    service.registerOwner({
        ownerId: 'owner_1',
        authority: 'uiLocal',
        ...view,
        navigationGeneration: 0,
        adapterKind: 'localPreview',
        fidelity: 'injectedPage',
        trustedInput: false,
        supportedActions: ['click', 'type', 'snapshot'],
        executeAction: () => new Promise((next) => { resolve = next; }),
    });
    const click = (id: string, actionKind = 'click') => service.executeAction({
        v: 1,
        automationRequestId: id,
        ...view,
        navigationGeneration: 0,
        requestedBy: 'agent',
        requesterRef: { kind: 'session', id: 'session_1' },
        actionKind,
        timeoutMs: 10_000,
    });
    const presence = (agentTurnActive?: boolean) => selectBrowserCopresence({
        snapshot: service.getSnapshot(),
        view,
        agentTurnActive,
        timeline: service.getActionTimeline(view),
    });
    return { service, click, presence, finish: (result: BrowserAutomationResult = { status: 'succeeded' }) => resolve(result) };
}

describe('selectBrowserCopresence', () => {
    it('keeps unknown completion after a failed fresh look and clears it only after the owner observes successfully', async () => {
        const { service, click, presence, finish } = setup();
        const pending = click('uncertain-click');
        await Promise.resolve();
        service.recordHumanInput({ ...view, inputKind: 'takeover', occurredAtMs: 1000 });
        finish();
        await pending;
        expect(presence()).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        let navigationGeneration = 0;
        const observe = (id: string) => service.executeAction({ v: 1, ...view, automationRequestId: id,
            navigationGeneration, requestedBy: 'user', requesterRef: { kind: 'session', id: 'session_1' },
            actionKind: 'snapshot', timeoutMs: 10_000 });
        const failed = observe('failed-look');
        await Promise.resolve();
        finish({ status: 'failed', errorCode: 'runtime_unavailable' });
        await failed;
        expect(presence()).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        const stale = observe('old-page-look');
        service.updateNavigationGeneration({ ...view, navigationGeneration: 1 });
        finish();
        expect(await stale).toMatchObject({ status: 'stale' });
        expect(presence()).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        navigationGeneration = 1;
        const succeeded = observe('fresh-look');
        await Promise.resolve();
        finish();
        await succeeded;
        expect(presence()).toMatchObject({ kind: 'human', interruptedCompletion: null });
    });
    it('follows the controller: agent while it acts, human after a takeover, idle after hand back', async () => {
        const { service, click, presence, finish } = setup();
        expect(presence()).toMatchObject({ kind: 'idle' });

        const pending = click('request_1', 'type');
        await Promise.resolve();
        expect(presence()).toMatchObject({ kind: 'agent', activity: 'type' });

        service.recordHumanInput({ ...view, inputKind: 'takeover', occurredAtMs: 1_000 });
        // The controller owner answers a takeover once the engine's interrupted work settles.
        finish();
        await pending;
        expect(presence(true)).toMatchObject({ kind: 'human', controlEpoch: 1 });

        service.releaseHumanControl(view);
        // The agent's turn is still running, but its last action belongs to the epoch before the
        // takeover: the capsule stays off until the agent acts again.
        expect(presence(true)).toMatchObject({ kind: 'idle' });
        finish();
    });

    it('keeps the agent present between two actions of a running turn, and only then', async () => {
        const { click, presence, finish } = setup();
        const pending = click('request_1');
        await Promise.resolve();
        finish();
        await pending;

        expect(presence(true)).toMatchObject({ kind: 'agent', activity: 'click' });
        expect(presence(false)).toMatchObject({ kind: 'idle' });
        expect(presence(undefined)).toMatchObject({ kind: 'idle' });
    });
});

describe('selectBrowserCopresence target', () => {
    it('carries the owner-reported page target for the agent cursor, and ignores anything off the page', () => {
        const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } as const;
        const snapshot = (activeTarget: unknown) => ({
            controllerByViewKey: {
                [browserViewKey(view)]: { controller: 'agent', controlEpoch: 0, activeActionKind: 'click', activeTarget },
            },
        });
        expect(selectBrowserCopresence({ snapshot: snapshot({ x: 0.5, y: 0.4, width: 0.3, height: 0.05, label: 'Sign in' }), view }))
            .toMatchObject({ kind: 'agent', target: { x: 0.5, y: 0.4, width: 0.3, height: 0.05, label: 'Sign in' } });
        expect(selectBrowserCopresence({ snapshot: snapshot({ x: 1.4, y: 0.4 }), view }))
            .toMatchObject({ kind: 'agent', target: null });
        expect(selectBrowserCopresence({ snapshot: snapshot(undefined), view }))
            .toMatchObject({ kind: 'agent', target: null });
    });
});

describe('selectBrowserCopresence for a daemon-owned view', () => {
    it('shows daemon uncertainty until its owner publishes a fresh settled observation', () => {
        const select = (controllerState: NonNullable<Parameters<typeof selectBrowserCopresence>[0]['controllerState']>) => selectBrowserCopresence({ snapshot: null, controllerState, view });
        expect(select({ controller: 'human', controlEpoch: 1, interruptionSettling: true })).toEqual({ kind: 'stopping', controlEpoch: 1 });
        expect(select({ controller: 'human', controlEpoch: 1, uncertain: true })).toEqual({ kind: 'human', controlEpoch: 1, interruptedCompletion: 'unknown' });
        expect(select({ controller: 'human', controlEpoch: 1, uncertain: false })).toEqual({ kind: 'human', controlEpoch: 1, interruptedCompletion: null });
    });
    it('follows the controller the daemon reported, not the in-app owner', () => {
        const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } as const;
        const inAppSaysAgent = {
            controllerByViewKey: { [browserViewKey(view)]: { controller: 'agent', controlEpoch: 0 } },
        };
        expect(selectBrowserCopresence({
            snapshot: inAppSaysAgent,
            controllerState: { controller: 'human', controlEpoch: 3 },
            view,
        })).toEqual({ kind: 'human', controlEpoch: 3, interruptedCompletion: null });
        // A daemon view's active request may be the person's own: no stopping is inferred from it.
        expect(selectBrowserCopresence({
            snapshot: null,
            controllerState: { controller: 'human', controlEpoch: 3, activeAutomationRequestId: 'r1' },
            view,
        })).toEqual({ kind: 'human', controlEpoch: 3, interruptedCompletion: null });
        expect(selectBrowserCopresence({
            snapshot: null,
            controllerState: { controller: 'agent', controlEpoch: 2, activeAutomationRequestId: 'r1' },
            view,
        })).toMatchObject({ kind: 'agent', controlEpoch: 2 });
    });
});

describe('selectBrowserCopresence while a takeover settles', () => {
    it('says stopping until the interrupted agent action settles, then that its effect is unknown', async () => {
        const { service, click, presence, finish } = setup();
        const pending = click('request_1');
        await Promise.resolve();

        service.recordHumanInput({ ...view, inputKind: 'takeover', occurredAtMs: 1_000 });
        // The owner still holds the interrupted click: nothing may claim human control yet.
        expect(presence(true)).toEqual({ kind: 'stopping', controlEpoch: 1 });

        finish();
        await pending;
        // Injected page input has no physical acknowledgement, so the click may have landed.
        expect(presence(true)).toEqual({ kind: 'human', controlEpoch: 1, interruptedCompletion: 'unknown' });
    });

    it('is plain human control when the takeover interrupted nothing', () => {
        const { service, presence } = setup();
        service.recordHumanInput({ ...view, inputKind: 'takeover', occurredAtMs: 1_000 });
        expect(presence(true)).toEqual({ kind: 'human', controlEpoch: 1, interruptedCompletion: null });
    });
});

describe('selectBrowserAgentPoint', () => {
    const target = { x: 0.5, y: 0.4, width: 0.3, height: 0.05 };
    const lastPoint = { id: 'req_1', controlEpoch: 2, target };

    it('keeps the latest action after the controller settles, but not across a takeover or while a person drives', () => {
        expect(selectBrowserAgentPoint({ lastPoint, presence: { kind: 'idle', controlEpoch: 2 } })).toEqual({ id: 'req_1', target });
        expect(selectBrowserAgentPoint({ lastPoint, presence: { kind: 'agent', activity: 'click', target: null, controlEpoch: 2 } }))
            .toEqual({ id: 'req_1', target });
        expect(selectBrowserAgentPoint({ lastPoint, presence: { kind: 'idle', controlEpoch: 3 } })).toBeNull();
        expect(selectBrowserAgentPoint({ lastPoint, presence: { kind: 'human', controlEpoch: 2, interruptedCompletion: null } })).toBeNull();
        expect(selectBrowserAgentPoint({ lastPoint, presence: { kind: 'stopping', controlEpoch: 2 } })).toBeNull();
        expect(selectBrowserAgentPoint({ lastPoint: null, presence: { kind: 'idle', controlEpoch: 2 } })).toBeNull();
    });

    it('is kept by the in-app automation owner after the action settles', async () => {
        const service = createBrowserAutomationControlService({ nowMs: () => 1_000 });
        service.registerOwner({
            ownerId: 'owner_1', authority: 'uiLocal', ...view, navigationGeneration: 0, adapterKind: 'localPreview',
            fidelity: 'injectedPage', trustedInput: false, supportedActions: ['click'],
            executeAction: async (_request, context) => {
                context.onActiveTarget?.(target);
                return { status: 'succeeded' };
            },
        });
        await service.executeAction({
            v: 1, automationRequestId: 'req_1', ...view, navigationGeneration: 0, requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' }, actionKind: 'click', timeoutMs: 10_000,
        });
        expect(readBrowserAgentPoint(service.getSnapshot(), view)).toMatchObject({ id: 'req_1', controlEpoch: 0, target });
    });
});
