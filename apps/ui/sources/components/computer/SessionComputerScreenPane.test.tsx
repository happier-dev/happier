import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonComputerActionExecuteRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

// Resolve the genuine cold graph only after its external network boundary is
// installed. Collection cost is not a Computer owner readiness deadline.
const network = await installSessionOpsNetworkBoundary();
await import('@/sync/ops/actions/defaultActionExecutor');
await import('./SessionComputerScreenPane');
await import('./ComputerScreenViewer');
await import('@/components/appShell/workspace/DestinationInstanceHost');
await import('@/components/ui/presentation/retainedPresentationSlots');
await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');

describe('SessionComputerScreenPane retained source', () => {
    let failedOwnerDiagnostic: (() => unknown) | null = null;
    beforeEach(() => { network.resetRequests(); failedOwnerDiagnostic = null; });
    afterEach(context => {
        if (context.task.result?.state === 'fail' && failedOwnerDiagnostic) {
            // Test-only phase evidence distinguishes setup failures from missing retention.
            console.error('Computer pane owner diagnostic', failedOwnerDiagnostic());
        }
    });
    afterAll(() => { network.dispose(); });

    it('retains the real Computer body and exact destination scope while parking ordinary read and stream demand', async () => {
        // Only HTTP/Socket.IO and device credentials are replaced; the actual pane,
        // model, control projection, Action executor and stream ingestion remain real.
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { createRetainedPresentationSlotsStore, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
        const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const executorModule = await loadVitestModuleForNodeRequire(
            new URL('../../sync/ops/actions/defaultActionExecutor.ts', import.meta.url),
            () => import('@/sync/ops/actions/defaultActionExecutor'),
        );
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const home = await network.addHome('https://computer-retention.test', 'computer-account');
        const sessionId = 'retained-computer-session';
        const machineId = 'retained-computer-machine';
        const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
        const sourceId = 'computer:retained';
        const initialStatus = createDeferred<void>();
        let phase = 'installing the real Home and Machine';
        let readBody: () => unknown = () => null;
        failedOwnerDiagnostic = () => ({ phase, body: readBody(),
            actions: network.requests.flatMap(request => {
                const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                return parsed.success ? [parsed.data.actionId] : [];
            }), http: network.httpRequests.map(request => request.url),
            credentials: network.credentialRequests,
        });
        network.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return null;
        });
        network.setRpcResponder(async request => {
            if (request.method !== RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE) throw new Error(`Unexpected Computer RPC: ${request.method}`);
            const payload = DaemonComputerActionExecuteRequestV1Schema.parse(request.payload);
            expect(payload.sessionId).toBe(sessionId);
            expect(request.targetId).toBe(machineId);
            if (payload.actionId === 'computer.targets.list') return { protocolVersion: 1, result: {
                targets: [{ target }], grants: { capture: 'granted', input: 'granted' },
            } };
            if (payload.actionId === 'computer.target.get') return { protocolVersion: 1, result: {
                consentGranted: true, selectedTarget: target, sourceId,
                approvalDisplay: { machineDisplayName: 'Retained computer', requiresTargetSelection: false, target: { kind: 'window', title: 'Retained window' } },
            } };
            if (payload.actionId === 'computer.control.status') {
                initialStatus.resolve();
                return { protocolVersion: 1, result: {
                    target, sourceId, controller: 'agent', controlEpoch: 1, stopping: false, uncertain: false,
                } };
            }
            throw new Error(`Unexpected Computer control: ${payload.actionId}`);
        });
        storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
        storage.getState().applyProfile({ ...storage.getState().profile, id: home.accountId });
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain' })], false, { sourceServerId: home.id });
        const sessionFixture = createSessionFixture({ id: sessionId, serverId: home.id, thinking: false });
        const session = { ...sessionFixture, metadata: { ...sessionFixture.metadata, machineId } };
        storage.getState().applySessions([session]);
        publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        apiSocket.initialize({ endpoint: home.serverUrl, token: home.token, serverId: home.id, generation: 1 }, null);
        phase = 'waiting for the real socket connection';
        const socketReady = createDeferred<void>();
        const stopStatus = apiSocket.onStatusChange(status => { if (status === 'connected') socketReady.resolve(); });
        const stopError = apiSocket.onError(error => { if (error) socketReady.reject(error); });
        try { await socketReady.promise; } finally { stopStatus(); stopError(); }
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime?.isCurrent()).toBe(true);
        phase = 'validating the real Action selection';
        // Establish the real parsed selection outcome before presentation work.
        // A refusal from this front door is fixture setup, never retention RED.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const producerDiagnostic = await createFrontDoorActionExecute()('computer.target.get', { machineId }, {
            surface: 'ui', authority: 'present_user', defaultSessionId: sessionId,
            serverId: home.id, expectedAccountId: home.accountId,
        });
        expect(producerDiagnostic, JSON.stringify({ http: network.httpRequests, credentials: network.credentialRequests }))
            .toMatchObject({ ok: true, result: { selectedTarget: target, sourceId } });
        phase = 'mounting the real Computer body';
        const { SessionComputerScreenPane } = await import('./SessionComputerScreenPane');
        const { ComputerScreenViewer } = await import('./ComputerScreenViewer');
        const store = createRetainedPresentationSlotsStore();
        const destinationId = 'computer-destination';
        const slotId = `${createSessionPaneScopeId(sessionId, home.id, destinationId)}:viewer:computer`;
        function Harness(props: Readonly<{ shell: 'pane' | 'floating' | 'closed' }>) {
            const pane = props.shell === 'pane' ? <SessionComputerScreenPane
                sessionId={sessionId} serverId={home.id} machineId={machineId} />
                : props.shell === 'floating' ? <SessionComputerScreenPane
                    sessionId={sessionId} serverId={home.id} machineId={machineId} presentationSlotId={slotId} /> : null;
            return <SessionViewerSourceAccountScopeProvider accountLifetime={accountLifetime}><RetainedPresentationSlotsProvider store={store}>
                {props.shell === 'pane' ? <DestinationInstanceHost tabId={destinationId}
                    ref={{ kind: 'session', params: { id: sessionId } }} pathname={`/session/${sessionId}`} focused visible>
                    {pane}
                </DestinationInstanceHost> : pane}
            </RetainedPresentationSlotsProvider></SessionViewerSourceAccountScopeProvider>;
        }
        const screen = await renderScreen(<Harness shell="pane" />);
        let lastBody: unknown = null;
        readBody = () => {
            try {
                const body = screen.root.findByType(ComputerScreenViewer);
                lastBody = { shared: body.props.shared, title: body.props.targetTitle,
                    presence: body.props.presence, stream: body.props.stream !== null,
                    accountScope: accountLifetime?.scope, accountCurrent: accountLifetime?.isCurrent() };
            } catch { /* Preserve the last mounted observation after genuine teardown. */ }
            return lastBody;
        };
        try {
            // Physical status completion follows the initial get/list phases;
            // microtask count alone is not an owner readiness predicate.
            phase = 'waiting for mounted get/list/status completion';
            await act(async () => { await initialStatus.promise; });
            await flushHookEffects();
            const body = screen.root.findByType(ComputerScreenViewer);
            expect(body.props.shared, JSON.stringify({ targetTitle: body.props.targetTitle, presence: body.props.presence,
                accountCurrent: accountLifetime?.isCurrent(), producer: producerDiagnostic,
                actions: network.requests.flatMap(request => {
                    const parsed = DaemonComputerActionExecuteRequestV1Schema.safeParse(request.payload);
                    return parsed.success ? [parsed.data.actionId] : [];
                }) })).toBe(true);
            expect(body.props.targetTitle).toBe('Retained window');
            expect(body.props.stream).not.toBeNull();
            phase = 'checking the retained source slot';
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            await screen.update(<Harness shell="floating" />);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            await screen.update(<Harness shell="closed" />);
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(body.props.stream).toBeNull();
            const parkedReads = network.requests.length;
            await act(async () => { storage.getState().applySessions([{ ...session, thinking: true }]); });
            await flushHookEffects();
            expect(network.requests).toHaveLength(parkedReads);
            await screen.update(<Harness shell="pane" />);
            await flushHookEffects();
            expect(screen.root.findByType(ComputerScreenViewer)).toBe(body);
            expect(body.props.targetTitle).toBe('Retained window');
            expect(store.getPortalSnapshot().map(entry => entry.slotId)).toEqual([slotId]);
            expect(network.requests.every(request => request.method === RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE)).toBe(true);
        } finally {
            readBody();
            await screen.unmount();
            apiSocket.disconnect();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
            executorModule.dispose();
        }
    });
});
