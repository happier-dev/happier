import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { createActionExecutor, computeHomeQrBindingProofV2, type ActionExecutorDeps } from '@happier-dev/protocol';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Keep the actual Socket and Sync lifecycle; only external Engine.IO packets stay disconnected.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// This native rendering package is outside the transport process and never renders here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
// Entropy is a genuine system boundary; this pins the request binding proof.
vi.mock('@/platform/cryptoRandom', () => ({ getRandomBytes: (size: number) => new Uint8Array(size).fill(7) }));
// Daemon RPC is the external terminal process boundary; Action admission and
// the canonical terminal request/response adapter remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Install genuine boundaries before the state graph resolves its transport imports.
const { storage } = await import('@/sync/domains/state/storageStore');
const { discardMachineAddFlowDraft, readMachineAddFlowDraft, updateMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
const { createManualSystemTaskRunner } = await import('@/dev/testkit/harness/manualSystemTaskRunner');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
const { createMachineConnectionActionDeps } = await import('./machineConnectionActionDeps');
const makeExecutor = (runner?: ReturnType<typeof createManualSystemTaskRunner>['runner']) => createActionExecutor({
    ...createMachineConnectionActionDeps({ runner }),
    // The terminal adapter does not own policy; compose the real host policy port.
    isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(
        actionId, normalizeActionsSettingsV1(context.actionsSettings), context, undefined, undefined, input,
    ),
} satisfies Partial<ActionExecutorDeps> as unknown as ActionExecutorDeps);

async function activateSshAccount(serverId: string, accountId: string) {
    const scope = createAccountSettingsScope(serverId, accountId);
    if (!scope) throw new Error('Invalid SSH fixture Account scope');
    await storage.getState().activateSettingsScope(scope);
    storage.getState().activateProfileScope(scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
}

describe('UI machine connection Actions', () => {
    beforeEach(async () => { await harness.reset(); boundary.rpc.mockReset(); });
    afterEach(() => { discardMachineAddFlowDraft(); publishAppliedActiveServerRuntimeAvailability(false); vi.unstubAllGlobals(); standardCleanup(); });
    it.each(['password', 'keyfile'] as const)('keeps entered SSH %s credentials private while invoking start, password response, status and cancel through UI Actions', async authMode => {
        vi.stubGlobal('isTauri', true);
        const serverId = await harness.addHome({ name: 'SSH Home', serverUrl: 'https://ssh-private.example', accountId: 'alice' });
        await activateSshAccount(serverId, 'alice');
        const manual = createManualSystemTaskRunner('native');
        updateMachineAddFlowDraft(draft => ({ ...draft, serverId, path: 'ssh', sshDraft: {
            ...draft.sshDraft, host: 'box', authMode, password: 'entered-password',
            ...(authMode === 'keyfile' ? { privateKeyMaterial: 'fixture-private-key' } : {}),
        } }));
        const executor = makeExecutor(manual.runner);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, bypassApprovals: true };
        const started = await executor.execute('machines.add.ssh.start', { serverId, host: 'box', authMode }, context);
        expect(started).toMatchObject({ ok: true, result: { taskId: expect.any(String) } });
        const taskId = readMachineAddFlowDraft().sshTask?.taskId;
        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ ssh: expect.objectContaining(
            authMode === 'keyfile' ? { identityPrivateKey: 'fixture-private-key' } : { password: 'entered-password' },
        ) }) }));
        manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'box' } });
        updateMachineAddFlowDraft(draft => ({ ...draft, sshDraft: { ...draft.sshDraft, password: 'corrected-password' } }));
        const answered = await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.password' } }, context);
        expect(answered).toEqual({ ok: true, result: { taskId } });
        expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'corrected-password' });
        const status = await executor.execute('machines.add.ssh.status', { taskId }, context);
        expect(status).toMatchObject({ ok: true, result: { taskId, machineId: null } });
        expect(JSON.stringify([started, answered, status])).not.toMatch(/entered-password|corrected-password|fixture-private-key/);
        manual.bridge.cancel.mockRejectedValueOnce(new Error('Native cancellation included fixture-cancel-secret-marker'));
        const failedCancel = await executor.execute('machines.add.ssh.cancel', { taskId }, context);
        expect(JSON.stringify(failedCancel).includes('fixture-cancel-secret-marker')).toBe(false);
        expect(failedCancel).toMatchObject({ ok: false, errorCode: 'machine_setup_cancel_failed', error: 'machine_setup_cancel_failed' });
        expect(await executor.execute('machines.add.ssh.cancel', { taskId }, context)).toEqual({ ok: true, result: { taskId } });
        expect(manual.bridge.cancel).toHaveBeenCalledWith(taskId);
        manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: false, error: { code: 'ssh_failed', message: 'fixture-diagnostic-marker' } });
        const failedStatus = await executor.execute('machines.add.ssh.status', { taskId }, context);
        expect(JSON.stringify(failedStatus).includes('fixture-diagnostic-marker')).toBe(false);
    });
    it('captures a saved host and SavedSecret for Agent/MCP without a mounted draft and persists exact completion', async () => {
        await loadSyncSingletonForTests();
        vi.stubGlobal('isTauri', true);
        const serverId = await harness.addHome({ name: 'Saved SSH', serverUrl: 'https://ssh-saved.example', accountId: 'alice' });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: AccountEncryptionCurrentnessResponseSchema.parse({
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        }) });
        await activateSshAccount(serverId, 'alice');
        const features = createRootLayoutFeaturesResponse({ features: { remoteHosts: { management: { enabled: true }, secretMaterial: { enabled: true } } } });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        harness.answer(serverId, '/v1/features', { body: features });
        const ref = formatSharedSavedSecretRefV1('ssh-password');
        const host = { id: 'saved-box', name: 'Saved box', createdAt: 1, updatedAt: 1, lastUsedAt: null,
            ssh: { target: 'alice@saved-box.example', authMode: 'password', passwordSecretRef: ref } };
        harness.answer(serverId, REMOTE_HOST_ROWS_ROUTE_V1, { body: { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
        harness.answer(serverId, '/v1/account/saved-secrets/resources/materials', { body: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
            resourceId: 'ssh-password', encryptionMode: 'plain', recipientEnvelope: null,
            entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password',
                encryptionMode: 'plain', revision: 2, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'saved-password' } },
        }] }) });
        harness.answer(serverId, `POST ${REMOTE_HOST_ROWS_ROUTE_V1}`, { body: { status: 'updated', revision: 5, cursor: 5 } });
        const manual = createManualSystemTaskRunner('native');
        const executor = makeExecutor(manual.runner);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId, bypassApprovals: true };
        const started = await executor.execute('machines.add.ssh.start', { serverId, savedHostId: host.id, expectedHostRevision: 4 }, context);
        expect(readMachineAddFlowDraft().sshTask?.startError, JSON.stringify(harness.requests.map(request => ({ serverId: request.serverId, path: request.path })))).toBeNull();
        expect(started).toEqual({ ok: true, result: { taskId: expect.any(String) } });
        const taskId = readMachineAddFlowDraft().sshTask?.taskId;
        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ ssh: expect.objectContaining({ target: host.ssh.target, password: 'saved-password' }) }) }));
        updateMachineAddFlowDraft(draft => ({ ...draft, sshDraft: { ...draft.sshDraft, host: 'unrelated-host', savedHostId: null, password: 'unrelated-password' } }));
        manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: host.ssh.target } });
        const answered = await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.password' } }, { ...context, surface: 'mcp' });
        expect(answered).toEqual({ ok: true, result: { taskId } });
        expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'saved-password' });
        manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: true, data: { machineId: 'joined-machine' } });
        await vi.waitFor(() => expect(harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1).some(request => {
            const input = request.input as { mutation?: { expectedRevision?: number; content?: { v?: { hosts?: { linkedMachineId?: string; id?: string }[] } } } };
            return input?.mutation?.expectedRevision === 4 && input.mutation.content?.v?.hosts?.some(row => row.id === host.id && row.linkedMachineId === 'joined-machine');
        })).toBe(true));
        expect(JSON.stringify([started, answered])).not.toMatch(/saved-password|unrelated-password/);
        const restarted = await executor.execute('machines.add.ssh.start', { serverId, savedHostId: host.id, expectedHostRevision: 4 }, context);
        expect(restarted).toEqual({ ok: true, result: { taskId: expect.any(String) } });
        const nextTaskId = readMachineAddFlowDraft().sshTask?.taskId;
        manual.emitEvent(nextTaskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: host.ssh.target } });
        manual.bridge.respond.mockRejectedValueOnce(new Error('Transport included fixture-secret-marker'));
        const refused = await executor.execute('machines.add.ssh.respond', { taskId: nextTaskId, answer: { kind: 'ssh.password' } }, { ...context, surface: 'mcp' });
        const saves = harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1).filter(request => request.input !== null).length;
        await harness.switchAccount(serverId, 'bob');
        await activateSshAccount(serverId, 'bob');
        await vi.waitFor(() => expect(manual.bridge.cancel).toHaveBeenCalledWith(nextTaskId));
        expect(manual.runner.getSnapshot(nextTaskId!)?.cancelRequested).toBe(true);
        const cancellations = manual.bridge.cancel.mock.calls.length;
        discardMachineAddFlowDraft();
        expect(readMachineAddFlowDraft().sshTask).toBeNull();
        expect(manual.bridge.cancel.mock.calls).toHaveLength(cancellations);
        manual.emitResult(nextTaskId!, { protocolVersion: 1, taskId: nextTaskId!, ok: true, data: { machineId: 'retired-machine' } });
        expect(harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1).filter(request => request.input !== null)).toHaveLength(saves);
        expect(JSON.stringify(refused).includes('fixture-secret-marker')).toBe(false);
        expect(refused).toMatchObject({ ok: false, errorCode: 'machine_setup_response_failed', error: 'machine_setup_response_failed' });
    });
    it.each(['machines.replacement.set', 'machines.replacement.clear'] as const)('invokes %s through Account admission and refuses a disabled policy before HTTP', async rawId => {
        const actionId = ActionIdSchema.parse(rawId);
        const serverId = await harness.addHome({ name: 'Replacement Home', serverUrl: 'https://replacement.example', accountId: 'alice' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' } });
        const path = '/v1/machines/old/replacement';
        harness.answer(serverId, path, { body: {} });
        const input = rawId === 'machines.replacement.set'
            ? { serverId, machineId: 'old', replacementMachineId: 'new', confirmActiveOldMachine: true }
            : { serverId, machineId: 'old' };
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice' };
        expect(await makeExecutor().execute(actionId, input, { ...context,
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { [rawId]: { enabled: false } } }),
        })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(harness.requestsFor(path)).toHaveLength(0);
        expect(await makeExecutor().execute(actionId, input, { ...context,
            surface: 'agent', authority: 'account_automation',
        })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(harness.requestsFor(path)).toHaveLength(0);
        expect(await makeExecutor().execute(actionId, input, { ...context,
            presentUserConfirmation: { actionId },
        })).toEqual({ ok: true, result: { ok: true } });
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(harness.requestsFor(path)[0]).toMatchObject({ serverId, input: rawId.endsWith('set')
            ? { replacementMachineId: 'new', confirmActiveOldMachine: true } : null });
        expect(await makeExecutor().execute(actionId, input, { ...context,
            expectedAccountId: 'bob', presentUserConfirmation: { actionId },
        })).toMatchObject({ ok: false, errorCode: 'account_settings_scope_changed' });
        expect(harness.requestsFor(path)).toHaveLength(1);
    });
    it('lists existing terminals on the requested Home and preserves method-unavailable fallback', async () => {
        const serverId = await harness.addHome({ name: 'Shell Home', serverUrl: 'https://shell.example', accountId: 'alice' });
        const signal = new AbortController().signal;
        boundary.rpc.mockResolvedValueOnce({ ok: true, terminals: [] });
        expect(await makeExecutor().execute('machines.terminal.list', { machineId: 'machine', serverId }, { surface: 'ui', authority: 'present_user', serverId, signal }))
            .toEqual({ ok: true, result: { ok: true, terminals: [] } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'machine', serverId, signal, method: 'daemon.terminal.list', payload: {} }));
        boundary.rpc.mockRejectedValueOnce({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        expect(await makeExecutor().execute('machines.terminal.list', { machineId: 'machine', serverId }, { surface: 'ui', authority: 'present_user', serverId }))
            .toEqual({ ok: true, result: null });
    });
    it('preserves a terminal write pre-effect refusal through the real Action executor', async () => {
        const serverId = await harness.addHome({ name: 'Input Home', serverUrl: 'https://input.example', accountId: 'alice' });
        const input = { machineId: 'machine', serverId, terminalId: 'pty', event: { t: 'text' as const, text: 'safe' } };
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId,
            actionsSettings: { v: 1 as const, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.write': ['ui' as const] } } };
        boundary.rpc.mockRejectedValueOnce(markRpcRequestDisposition(Object.assign(new Error('offline'), {
            code: 'RPC_CLIENT_NOT_AVAILABLE', rpcErrorCode: 'RPC_CLIENT_NOT_AVAILABLE',
        }), 'notSent'));
        expect(await makeExecutor().execute('machines.terminal.write', input, context)).toMatchObject({
            ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE', effectAttempted: false,
        });
        boundary.rpc.mockResolvedValueOnce({ ok: true });
        expect(await makeExecutor().execute('machines.terminal.write', input, context)).toEqual({ ok: true, result: { ok: true } });
    });

    it('stops the exact Machine daemon through admitted UI Action RPC', async () => {
        const serverId = await harness.addHome({ name: 'Stop Home', serverUrl: 'https://stop.example', accountId: 'alice' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        boundary.rpc.mockResolvedValueOnce({ message: 'Stopped' });
        expect(await makeExecutor().execute('machines.daemon.stop', { serverId, machineId: 'machine' }, {
            surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice',
            presentUserConfirmation: { actionId: 'machines.daemon.stop' },
        })).toEqual({ ok: true, result: { message: 'Stopped' } });
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId, method: RPC_METHODS.STOP_DAEMON, payload: {} }));
    });
    it('refuses a daemon stop after its captured Account changes before issuing RPC', async () => {
        const serverId = await harness.addHome({ name: 'Stop Home', serverUrl: 'https://stop.example', accountId: 'alice' });
        await harness.switchAccount(serverId, 'bob');
        const result = await createMachineConnectionActionDeps().machinePageAction!({
            actionId: 'machines.daemon.stop', input: { serverId, machineId: 'machine' },
            context: { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice' },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'account_settings_scope_changed' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it('opens a terminal with a configured UI waiver on the requested Home and retains the daemon handle', async () => {
        const serverId = await harness.addHome({ name: 'Shell Home', serverUrl: 'https://shell.example', accountId: 'alice' });
        const signal = new AbortController().signal;
        boundary.rpc.mockResolvedValueOnce({ ok: true, terminalId: 'pty', reused: true });
        expect(await makeExecutor().execute('machines.terminal.open', { machineId: 'machine', serverId, terminalKey: 'shell', cwd: '/project' }, {
            surface: 'ui', authority: 'present_user', serverId, signal,
            actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } },
        })).toEqual({ ok: true, result: { ok: true, terminalId: 'pty', reused: true } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ serverId, machineId: 'machine', signal,
            method: RPC_METHODS.DAEMON_TERMINAL_ENSURE, payload: { terminalKey: 'shell', cwd: '/project' } }));
    });
    it('rejects an invalid Home address through the canonical connection owner', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://existing.example', accountId: 'alice' });
        expect(await makeExecutor().execute('homes.connect', { address: 'ftp://wrong.example' }, {
            surface: 'ui', authority: 'present_user', serverId,
        })).toEqual({ ok: true, result: { kind: 'invalid_address' } });
        expect(harness.requests.some((request) => request.serverUrl === 'ftp://wrong.example')).toBe(false);
    });
    it('reconnects the focused Home through the real connection lifecycle', async () => {
        await loadSyncSingletonForTests();
        const serverId = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        expect(getActiveServerAccountScope()).toBeNull();
        try {
            expect(await makeExecutor().execute('homes.reconnect', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId,
            })).toEqual({ ok: true, result: { serverId } });
            expect(getActiveServerAccountScope()).toMatchObject({
                serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice',
            });
        } finally {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
    });
    it('refuses reconnecting an unfocused Home rather than retrying another Home', async () => {
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other.example', accountId: 'alice' });
        await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId: other }, {
            surface: 'ui', authority: 'present_user', serverId: other,
        })).toMatchObject({ ok: false, errorCode: 'home_not_focused' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('does not retry using a replacement Account after the admitted Account retires', async () => {
        await loadSyncSingletonForTests();
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await harness.switchAccount(serverId, 'bob');
            expect(account.accountLifetime.isCurrent()).toBe(false);
            const executor = createActionExecutor(createMachineConnectionActionDeps({ account }) as ActionExecutorDeps);
            const result = await executor.execute('homes.reconnect', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice',
            });
            expect(result.ok).toBe(false);
            expect(getActiveServerAccountScope()).toBeNull();
        } finally {
            account.dispose();
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
    });
    it('refuses reconnecting with a mismatched Action scope before touching transport', async () => {
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other.example', accountId: 'alice' });
        const focused = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId: focused }, {
            surface: 'ui', authority: 'present_user', serverId: other,
        })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('does not reconnect after caller cancellation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const controller = new AbortController();
        controller.abort();
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId }, {
            surface: 'ui', authority: 'present_user', serverId, signal: controller.signal,
        })).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('prepares Windows SSH setup without exposing credentials or starting a native task', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://setup.example', accountId: 'alice' });
        const result = await makeExecutor().execute('machines.add.command', {
            serverId, method: 'ssh', os: 'windows', host: 'ssh.example', port: 2222, username: 'alice', authMode: 'keyfile', identityFilePath: 'C:\\Keys\\ssh key',
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { descriptorFileRequired: false } });
        if (!result.ok || typeof result.result !== 'object' || result.result === null || !('command' in result.result)) throw new Error('No setup command');
        expect(result.result.command).toContain('happier machine setup');
        expect(result.result.command).toContain('--ssh-port 2222');
        expect(result.result.command).toContain('--home-url https://setup.example');
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it('retires the trusted pairing lifecycle after returning its link when the Home Account changes', async () => {
        await loadSyncSingletonForTests();
        const identity = 'srv_pairing-home';
        const serverUrl = 'https://pairing.example';
        const serverId = await harness.addHome({ name: 'Pairing Home', serverUrl, serverIdentityId: identity, accountId: 'alice' });
        const descriptor = { v: 1 as const, homeServerIdentityId: identity, canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https' as const, url: serverUrl }] };
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({ descriptor, source: 'manual' });
        const features = { ...createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId: identity } },
            features: { auth: { pairing: { boundQrV2: { enabled: true }, desktopQrMobileScan: { enabled: false } } } } }), homeConnectionDescriptor: descriptor };
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features, serverIdentityId: identity } });
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const expiresAtMs = Date.now() + 60_000;
        const expiresAt = new Date(expiresAtMs).toISOString();
        harness.answer(serverId, '/v1/auth/pairing/start', { body: { pairId: 'pair', expiresAt } });
        let releaseStatus!: () => void;
        const heldStatus = new Promise<void>((resolve) => { releaseStatus = resolve; });
        const requesterPublicKey = new Uint8Array(32).fill(9);
        const statusPath = '/v1/auth/pairing/status?pairId=pair';
        harness.answer(serverId, statusPath, { respondAfter: heldStatus, body: { state: 'requested', pairId: 'pair', expiresAt,
            requestedPublicKey: encodeBase64(requesterPublicKey), requestedDeviceLabel: 'Computer', homeServerIdentityId: identity,
            bindingProof: computeHomeQrBindingProofV2({ direction: 'trusted_home_displays', qrSecret: new Uint8Array(32).fill(7),
                pairId: 'pair', homeServerIdentityId: identity, requesterPublicKey, expiresAtMs }) } });
        harness.answer(serverId, '/v1/auth/pairing/consume', { body: {} });
        try {
            const result = await makeExecutor().execute('machines.pairing.create', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId,
                presentUserConfirmation: { actionId: 'machines.pairing.create' },
            });
            if (!result.ok) throw new Error(JSON.stringify(result));
            expect(result).toMatchObject({ ok: true, result: { pairId: 'pair', expiresAtMs } });
            await vi.waitFor(() => expect(harness.requestsFor(statusPath)).toHaveLength(1));
            await harness.switchAccount(serverId, 'bob');
            await vi.waitFor(() => expect(harness.requestsFor('/v1/auth/pairing/consume')).toHaveLength(1));
            expect(harness.requestsFor('/v1/auth/pairing/consume')[0]?.input).toEqual({ pairId: 'pair', intent: 'cancel' });
            releaseStatus();
            await Promise.resolve();
            expect(harness.requests.some((request) => request.path.includes('response'))).toBe(false);
        } finally { releaseStatus(); }
    });
});
