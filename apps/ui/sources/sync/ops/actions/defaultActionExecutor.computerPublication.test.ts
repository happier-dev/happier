import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonComputerActionExecuteRequestV1Schema, type ComputerTargetsListResponseV1 } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ComputerSessionControl } from '@/components/computer/useComputerSessionControl';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook, type RenderHookResult } from '@/dev/testkit/hooks/renderHook';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import type { ComputerApprovalChoice } from '@/components/approvals/useComputerApprovalChoice';

// Install the genuine network boundary before loading the real graph. Collection
// owns the cold transform cost; each scenario still constructs its own Account.
const network = await installSessionOpsNetworkBoundary();
await import('./defaultActionExecutor');
await import('@/modal');
await import('@/components/computer/openComputerTargetPickerForSession');

describe('default Action Computer Account publication', () => {
    beforeEach(() => { network.resetRequests(); });
    afterAll(() => { network.dispose(); });

    it('names the exact Home in the real picker when two Homes have the same Session id', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let bridge: Awaited<ReturnType<typeof loadVitestModuleForNodeRequire>> | null = null;
        try {
            const homeA = await network.addHome('https://computer-picker-a.test', 'picker-account-a');
            const homeB = await network.addHome('https://computer-picker-b.test', 'picker-account-b');
            const sessionId = 'duplicate-picker-session';
            const machineId = 'picker-machine-b';
            const pickerRead = createDeferred<void>();
            const sessionB = createSessionFixture({ id: sessionId, serverId: homeB.id, updatedAt: 1 });
            const sessionA = createSessionFixture({ id: sessionId, serverId: homeA.id, updatedAt: 2 });
            network.setHttpResponder(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                return null;
            });
            network.setRpcResponder(async request => {
                expect(request.serverUrl).toBe(homeB.serverUrl);
                expect(request.token).toBe(homeB.token);
                expect(request.targetId).toBe(machineId);
                const payload = DaemonComputerActionExecuteRequestV1Schema.parse(request.payload);
                expect(payload.sessionId).toBe(sessionId);
                if (payload.actionId === 'computer.targets.list') {
                    pickerRead.resolve();
                    return { protocolVersion: 1, result: {
                        targets: [], grants: { capture: 'granted', input: 'granted' },
                    } };
                }
                if (payload.actionId === 'computer.target.get') return { protocolVersion: 1, result: {
                    consentGranted: false, approvalDisplay: { machineDisplayName: 'Home B machine', requiresTargetSelection: true },
                } };
                throw new Error(`Unexpected picker action: ${payload.actionId}`);
            });
            storage.getState().activateProfileScope({ serverId: homeA.id, accountId: homeA.accountId });
            storage.getState().applyProfile({ ...storage.getState().profile, id: homeA.accountId });
            storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain' })], false, { sourceServerId: homeB.id });
            storage.getState().applySessions([{ ...sessionB, metadata: { ...sessionB.metadata, name: 'Home B Session', path: '/workspace/project-b', machineId } }]);
            storage.getState().applySessions([{ ...sessionA, metadata: { ...sessionA.metadata, name: 'Home A Session', path: '/workspace/project-a' } }]);
            expect(storage.getState().sessions[sessionId]?.serverId).toBe(homeA.id);
            const { findSessionListLookupSession } = await import('@/sync/domains/session/listing/sessionListLookupState');
            expect(findSessionListLookupSession(storage.getState(), { serverId: homeB.id, sessionId })?.session.metadata?.name).toBe('Home B Session');
            publishAppliedActiveServerSnapshot({ serverId: homeA.id, serverUrl: homeA.serverUrl, generation: 1 }, false);
            account = await captureLazyActionAccountContext(homeB.id);
            expect(account.accountLifetime.isCurrent()).toBe(true);
            const accountLifetime = account.accountLifetime;
            bridge = await loadVitestModuleForNodeRequire(new URL('./defaultActionExecutor.ts', import.meta.url), () => import('./defaultActionExecutor'));
            const { ModalProvider } = await import('@/modal');
            const { openComputerTargetPickerForSession } = await import('@/components/computer/openComputerTargetPickerForSession');
            screen = await renderScreen(React.createElement(ModalProvider));
            await act(async () => { openComputerTargetPickerForSession({
                sessionId, serverId: homeB.id, accountLifetime,
                machineId, machineName: 'Home B machine', onSelected: () => {},
            }); });
            await act(async () => { await pickerRead.promise; });
            await flushHookEffects();
            const { ComputerTargetPicker } = await import('@/components/computer/ComputerTargetPicker');
            await vi.waitFor(() => {
                expect(screen?.findAllByType(ComputerTargetPicker)[0]?.props.state).toMatchObject({ kind: 'ready' });
            });
            const visible = screen.getTextContent();
            expect(visible).toContain('Home B Session');
            expect(visible).toContain('project-b');
            expect(visible).not.toContain('Home A Session');
            expect(visible).not.toContain('project-a');
        } finally {
            await screen?.unmount();
            account?.dispose();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
            bridge?.dispose();
        }
    });

    it('retires Account-bound Computer read publication and an actual approval choice through the default front door', async () => {
        // Only HTTP, Socket.IO and device credentials are boundary substitutes.
        // Admission, Account capture, scoped transport and projections remain real.
        const { useComputerSessionControl } = await import('@/components/computer/useComputerSessionControl');
        const { useComputerApprovalChoice } = await import('@/components/approvals/useComputerApprovalChoice');
        const { createComputerControlClient } = await import('@/sync/domains/computer/computerControlClient');
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const pendingA = createDeferred<ComputerTargetsListResponseV1>();
        const issuedA = createDeferred<void>();
        const readyA = createDeferred<void>();
        const readyB = createDeferred<void>();
        const pickerRead = createDeferred<void>();
        let readerA: RenderHookResult<ComputerSessionControl, void> | null = null;
        let readerB: typeof readerA = null;
        let borrowedB: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        let approvalScreen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        let executorBridge: Awaited<ReturnType<typeof loadVitestModuleForNodeRequire>> | null = null;
        let holdAReadiness = false;
        let waitingForPickerRead = false;
        try {
            const home = await network.addHome('https://computer-publication.test', 'publication-account-a');
            const scope = { serverId: home.id, sessionId: 'publication-session', machineId: 'publication-machine' };
            const target = { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } as const;
            const selectedA = { consentGranted: true, selectedTarget: target, sourceId: 'computer:publication-a',
                approvalDisplay: { machineDisplayName: 'Publication machine', requiresTargetSelection: false,
                    target: { kind: 'window', title: 'Account A window' } } };
            const selectedB = { ...selectedA, sourceId: 'computer:publication-b',
                approvalDisplay: { ...selectedA.approvalDisplay, target: { kind: 'window', title: 'Account B window' } } };
            network.setHttpResponder(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                return null;
            });
            network.setRpcResponder(async request => {
                expect(request.method).toBe(RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE);
                expect(request.targetId).toBe(scope.machineId);
                const payload = DaemonComputerActionExecuteRequestV1Schema.parse(request.payload);
                expect(payload.sessionId).toBe(scope.sessionId);
                const isA = request.token === home.token;
                const selected = isA ? selectedA : selectedB;
                if (payload.actionId === 'computer.target.get') return { protocolVersion: 1, result: selected };
                if (payload.actionId === 'computer.targets.list') {
                    if (isA && holdAReadiness) {
                        issuedA.resolve();
                        return { protocolVersion: 1, result: await pendingA.promise };
                    }
                    if (waitingForPickerRead) pickerRead.resolve();
                    return { protocolVersion: 1, result: { targets: [{ target, title: selected.approvalDisplay.target.title }], grants: { capture: 'granted', input: 'granted' } } };
                }
                if (payload.actionId === 'computer.control.status') {
                    (isA ? readyA : readyB).resolve();
                    return { protocolVersion: 1, result: { target, sourceId: selected.sourceId,
                        controller: 'human', controlEpoch: 1, stopping: false, uncertain: false } };
                }
                throw new Error(`Unexpected Computer effect: ${payload.actionId}`);
            });
            storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
            storage.getState().applyProfile({ ...storage.getState().profile, id: home.accountId });
            storage.getState().applyMachines([createMachineFixture({ id: scope.machineId, storageMode: 'plain' })], false, { sourceServerId: home.id });
            const sessionFixture = createSessionFixture({ id: scope.sessionId, serverId: home.id, thinking: false });
            storage.getState().applySessions([{ ...sessionFixture, metadata: { ...sessionFixture.metadata, machineId: scope.machineId } }]);
            publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
            apiSocket.initialize({ endpoint: home.serverUrl, token: home.token, serverId: home.id, generation: 1 }, null);
            const connected = createDeferred<void>();
            const stopStatus = apiSocket.onStatusChange(status => { if (status === 'connected') connected.resolve(); });
            const stopError = apiSocket.onError(error => { if (error) connected.reject(error); });
            try { await connected.promise; } finally { stopStatus(); stopError(); }
            const executor = createDefaultActionExecutor();
            const accountLifetimeA = captureActiveServerAccountScopeLifetime();
            expect(accountLifetimeA?.isCurrent()).toBe(true);
            readerA = await renderHook(() => {
                const control = useComputerSessionControl({ scope, execute: executor.execute, accountLifetime: accountLifetimeA });
                if (control.failure) readyA.reject(new Error(control.failure));
                return control;
            });
            await act(async () => { await readyA.promise; });
            expect(readerA.getCurrent().selection?.sourceId).toBe(selectedA.sourceId);
            executorBridge = await loadVitestModuleForNodeRequire(new URL('./defaultActionExecutor.ts', import.meta.url),
                () => import('./defaultActionExecutor'));
            const { ModalProvider } = await import('@/modal');
            const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
            const { openComputerTargetPickerForSession } = await import('@/components/computer/openComputerTargetPickerForSession');
            const choice: { current: ComputerApprovalChoice | null } = { current: null };
            function currentChoice(): ComputerApprovalChoice {
                if (!choice.current) throw new Error('Actual Computer approval choice did not mount');
                return choice.current;
            }
            function ApprovalChoice(props: Readonly<{ artifactId: string }>) {
                choice.current = useComputerApprovalChoice({ artifactId: props.artifactId, actionId: 'computer.target.select',
                    actionArgs: { machineId: scope.machineId, requestedTarget: 'Account A window' }, sessionId: scope.sessionId, serverId: home.id,
                    preview: { computerApprovalDisplay: { machineDisplayName: 'Publication machine', requiresTargetSelection: true } },
                    resolveOpenPicker: () => openComputerTargetPickerForSession });
                return null;
            }
            const approvalElement = (artifactId: string) => React.createElement(ModalProvider, null,
                React.createElement(SessionViewerSourceAccountScopeProvider, { accountLifetime: accountLifetimeA },
                    React.createElement(ApprovalChoice, { artifactId })));
            approvalScreen = await renderScreen(approvalElement('publication-approval-a'));
            expect(currentChoice().presentation).toMatchObject({ act: 'share', requiresTargetSelection: true });
            waitingForPickerRead = true;
            await act(async () => { currentChoice().chooseTarget(); });
            const { ComputerTargetPicker } = await import('@/components/computer/ComputerTargetPicker');
            const { ComputerTargetPickerModal } = await import('@/components/computer/showComputerTargetPicker');
            // The default front door captures credentials/settings and admits
            // the real Machine route before the picker's own list can settle.
            // Await that physical phase under the containing test deadline,
            // rather than giving admission vi.waitFor's shorter default cutoff.
            await act(async () => { await pickerRead.promise; });
            await flushHookEffects();
            await vi.waitFor(async () => {
                await act(async () => {});
                const picker = approvalScreen?.findAllByType(ComputerTargetPicker)[0];
                const modal = approvalScreen?.findAllByType(ComputerTargetPickerModal)[0];
                const diagnostic = JSON.stringify({ picker: picker?.props.state,
                    scope: modal?.props.scope, refusal: modal?.props.refusalCode,
                    modalAccountScope: modal?.props.accountLifetime?.scope,
                    modalAccountCurrent: modal?.props.accountLifetime?.isCurrent(),
                    borrowsInvokingAccount: modal?.props.accountLifetime === accountLifetimeA,
                    invokingAccountCurrent: accountLifetimeA?.isCurrent(),
                    actions: network.requests.map(request => DaemonComputerActionExecuteRequestV1Schema.parse(request.payload).actionId),
                    http: network.httpRequests, credentials: network.credentialRequests });
                expect(picker?.props.state, diagnostic).toMatchObject({ kind: 'ready' });
            });
            await approvalScreen.pressByTestIdAsync('computer-target-picker-target:window');
            await approvalScreen.pressByTestIdAsync('computer-target-picker-share');
            expect(currentChoice().decisionOptions).toEqual({ computerTarget: target, computerAccess: 'use' });
            expect(currentChoice().presentation?.target?.title).toBe('Account A window');
            await act(async () => { currentChoice().chooseTarget(); });
            await vi.waitFor(() => {
                expect(approvalScreen?.findAllByType(ComputerTargetPicker)[0]?.props.state).toMatchObject({ kind: 'ready' });
            });
            // Another actual approval in the same Account/Session has its own
            // consent choice even when the requested Machine/window is equal.
            await approvalScreen.update(approvalElement('publication-approval-b'));
            expect(currentChoice().decisionOptions).toEqual({});
            expect(currentChoice().presentation?.target).toBeNull();
            expect(currentChoice().needsChoiceBeforeApprove).toBe(true);
            // The already-open picker belongs to the previous approval. A
            // late pick cannot choose a target for the newly mounted request.
            await approvalScreen.pressByTestIdAsync('computer-target-picker-target:window');
            await approvalScreen.pressByTestIdAsync('computer-target-picker-share');
            expect(currentChoice().decisionOptions).toEqual({});
            await act(async () => { currentChoice().chooseTarget(); });
            await vi.waitFor(() => {
                expect(approvalScreen?.findAllByType(ComputerTargetPicker)[0]?.props.state).toMatchObject({ kind: 'ready' });
            });
            await approvalScreen.pressByTestIdAsync('computer-target-picker-target:window');
            await approvalScreen.pressByTestIdAsync('computer-target-picker-share');
            expect(currentChoice().decisionOptions).toEqual({ computerTarget: target, computerAccess: 'use' });
            holdAReadiness = true;
            const clientA = createComputerControlClient(scope, executor.execute, accountLifetimeA);
            const answerA = clientA.listTargets();
            await Promise.race([issuedA.promise, answerA.then(result => {
                throw new Error(`Account A read settled before its Machine RPC: ${JSON.stringify(result)}`);
            })]);
            await act(async () => {
                storage.getState().activateProfileScope({ serverId: home.id, accountId: 'publication-account-b' });
                publishAppliedActiveServerRuntimeAvailability(false);
            });
            // The real approval page withdraws its body, not this choice hook,
            // while the credential-backed Account reader is rebound.
            expect(currentChoice().decisionOptions).toEqual({});
            expect(currentChoice().presentation?.target).toBeNull();
            await readerA.unmount();
            readerA = null;
            network.setAccount(home.serverUrl, 'publication-account-b');
            storage.getState().applyProfile({ ...storage.getState().profile, id: 'publication-account-b' });
            storage.getState().applyMachines([createMachineFixture({ id: scope.machineId, storageMode: 'plain' })], false, { sourceServerId: home.id });
            // During the real applied-runtime reset, saved Home reads use their
            // own credential-backed scoped transport, never Account A's socket.
            borrowedB = await captureLazyActionAccountContext(home.id);
            expect(borrowedB.accountLifetime.scope.accountId).toBe('publication-account-b');
            const accountLifetime = borrowedB.accountLifetime;
            readerB = await renderHook(() => {
                const control = useComputerSessionControl({ scope, execute: executor.execute, accountLifetime });
                if (control.failure) readyB.reject(new Error(control.failure));
                return control;
            });
            await act(async () => { await readyB.promise; });
            expect(readerB.getCurrent().selection?.sourceId).toBe(selectedB.sourceId);
            expect(readerB.getCurrent().presence.kind).toBe('human');
            await act(async () => {
                pendingA.resolve({ targets: [], grants: { capture: 'denied', input: 'denied' } });
                expect(await answerA).toEqual({ ok: false, code: 'action_account_scope_changed' });
            });
            expect(readerB.getCurrent().selection?.sourceId).toBe(selectedB.sourceId);
            expect(readerB.getCurrent().targetTitle).toBe('Account B window');
            expect(readerB.getCurrent().canRead).toBe(true);
        } finally {
            await approvalScreen?.unmount();
            await readerA?.unmount();
            await readerB?.unmount();
            pendingA.resolve({ targets: [], grants: { capture: 'denied', input: 'denied' } });
            borrowedB?.dispose();
            apiSocket.disconnect();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
            executorBridge?.dispose();
        }
    });
    it('never sends a retained Account Computer request under replacement credentials for the same Home and Machine', async () => {
        const { createComputerRuntimeActionExecutor } = await import('@/sync/domains/computer/actions/runtimeActionExecutor');
        const { createUnavailableRuntimeActionExecutor } = await import('@happier-dev/protocol');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        try {
            const home = await network.addHome('https://computer-execution-account.test', 'computer-execution-account-a');
            const machineId = 'same-account-execution-machine';
            network.setHttpResponder(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                return null;
            });
            storage.getState().activateProfileScope({ serverId: home.id, accountId: home.accountId });
            storage.getState().applyProfile({ ...storage.getState().profile, id: home.accountId });
            publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 }, false);
            account = await captureLazyActionAccountContext(home.id);
            expect(account.accountLifetime.isCurrent()).toBe(true);
            const accountId = account.accountLifetime.scope.accountId;
            network.setAccount(home.serverUrl, 'computer-execution-account-b');
            storage.getState().activateProfileScope({ serverId: home.id, accountId: 'computer-execution-account-b' });
            storage.getState().applyProfile({ ...storage.getState().profile, id: 'computer-execution-account-b' });
            storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain' })], false, { sourceServerId: home.id });
            network.setRpcResponder(async request => {
                expect(request.token).not.toBe(home.token);
                return { protocolVersion: 1, result: { consentGranted: false,
                    approvalDisplay: { machineDisplayName: 'Replacement Account machine', requiresTargetSelection: true } } };
            });
            const execute = createComputerRuntimeActionExecutor({
                fallback: createUnavailableRuntimeActionExecutor(), accountLifetime: account.accountLifetime,
            });
            const result = await execute({
                actionId: 'computer.target.get', input: { machineId },
                context: { serverId: home.id, runtimeAccountId: accountId,
                    defaultSessionId: 'retained-execution-session', authority: 'present_user' },
            });
            expect(result).toMatchObject({ ok: false });
            expect(network.requests).toEqual([]);
        } finally {
            account?.dispose();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });
});
