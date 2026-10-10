import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { decideApprovalAsInbox, replayApprovedAsDaemon } from '@/dev/testkit/harness/approvalInbox';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol/connect/recoveryCreditConsumeIdempotencyKey';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Modal } from '@/modal';
import { useAccountUsageResetAction } from './useAccountUsageResetAction';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
installDisconnectedServerSocketBoundary();
// Substitute only Metro's lazy loader; the default and Protocol Action executors stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it.each(['approve', 'reject', 'disabled', 'stale'] as const)('admits the shared reset through Action policy and fresh targets (%s)', async decision => {
    const bridge = await loadSyncSingletonForTests();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'reset-account', encryptionMode: 'plain' });
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
        'connectedServices.quota.reset': decision === 'disabled' ? { disabledSurfaces: ['ui'] } : { approvalRequiredSurfaces: ['ui'] },
    } });
    const account = await restoreServerAccountForTest({ serverUrl: 'https://reset-approval.test',
        serverIdentityId: 'srv_reset_approval', accountId: 'reset-account', request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            const artifact = artifacts.handle(path, init);
            if (artifact) return artifact;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return Response.json({}, { status: 404 });
        } });
    const active = getActiveServerSnapshot();
    const machine = createMachineFixture({ id: 'selected-machine', activeAt: Date.now() });
    storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'reset-account' });
    await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'reset-account' });
    storage.getState().applyProfile({ ...profileDefaults, id: 'reset-account' });
    storage.getState().applySettings({ ...settingsDefaults, actionsSettingsV1, machineAdministrationTargetsLocalV1: {
        [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { serverIdentityId: 'srv_reset_approval', machineId: machine.id },
    } }, 1);
    storage.getState().applyMachines([machine], true, { sourceServerId: active.serverId });
    storage.setState({ isDataReady: true });
    const spends: unknown[] = [];
    const rpc = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (machineId, method, payload) => {
        if (method === RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED) {
            return await replayApprovedAsDaemon({ serverId: active.serverId, machineId,
                artifactId: String(Reflect.get(payload as object, 'artifactId')) });
        }
        if (method !== RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME) throw new Error(`Unexpected machine RPC ${method}`);
        spends.push(payload);
        return { ok: true, receipt: { idempotencyKey: 'reset-receipt', providerCreditId: 'credit-1', status: 'nothing_to_reset' }, snapshot: null };
    });
    let applied = false;
    const hook = await renderHook(() => useAccountUsageResetAction({ legacyServiceId: 'openai-codex', accountId: 'work',
        // Plans omits detail admission; the sibling detail path supplies its exact fresh choice.
        machineId: decision === 'approve' ? undefined : machine.id,
        snapshotFetchedAtMs: 123, onApplied: () => { applied = true; } }));
    let request: Promise<void> | undefined;
    try {
        if (decision === 'stale') storage.getState().applyMachines([{ ...machine, active: false, activeAt: 0 }], true, { sourceServerId: active.serverId });
        await act(async () => { request = hook.getCurrent().use('credit-1'); });
        if (decision === 'disabled' || decision === 'stale') {
            await act(async () => { await request; });
            expect(artifacts.list()).toEqual([]);
            expect(rpc).not.toHaveBeenCalled();
            expect(applied).toBe(false);
            return;
        }
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        const artifactId = artifacts.list()[0]!.id;
        expect(hook.getCurrent().pending).toBe(true);
        expect(rpc).not.toHaveBeenCalled();
        expect(applied).toBe(false);
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({
            status: 'open', actionId: 'connectedServices.quota.reset', actionArgs: {
                machineId: machine.id, serviceId: 'openai-codex', profileId: 'work', providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 123,
            },
        });
        await decideApprovalAsInbox(active.serverId, artifactId, decision);
        await waitForHomeGovernance(() => expect(hook.getCurrent().pending).toBe(false));
        await request;
        if (decision === 'approve') {
            expect(spends).toEqual([expect.objectContaining({
                serviceId: 'openai-codex', profileId: 'work', providerCreditId: 'credit-1',
                idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey({ serviceId: 'openai-codex', profileId: 'work',
                    providerCreditId: 'credit-1', sourceSnapshotFetchedAtMs: 123 }),
            })]);
            expect(applied).toBe(true);
            expect(Modal.alert).toHaveBeenCalledWith('common.info', 'connectedServices.quota.recoveryCreditNothingToReset');
            expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({
                status: 'executed', execution: { ok: true, result: { receipt: { status: 'nothing_to_reset' } } },
            });
        } else {
            expect(rpc).not.toHaveBeenCalled();
            expect(applied).toBe(false);
        }
    } finally { await hook.unmount(); await request; await account.dispose(); bridge.dispose(); storage.getState().clearProfileScope(); }
});

it.each([null, 'different-machine'])('refuses a usage reset outside the explicitly admitted detail machine (%s)', async machineId => {
    const bridge = await loadSyncSingletonForTests();
    await adoptHomeProfile({ descriptor: { serverUrl: 'https://reset-admission.test', homeServerIdentityId: 'srv_reset_admission' }, source: 'manual' });
    const account = await restoreServerAccountForTest({ serverUrl: 'https://reset-admission.test', accountId: 'reset-account',
        request: async () => Response.json({}, { status: 404 }) });
    const active = getActiveServerSnapshot();
    const machine = createMachineFixture({ id: 'selected-machine', activeAt: Date.now() });
    storage.getState().activateProfileScope({ serverId: active.serverId, accountId: 'reset-account' });
    await storage.getState().activateSettingsScope({ serverId: active.serverId, accountId: 'reset-account' });
    storage.getState().applyProfile({ ...profileDefaults, id: 'reset-account' });
    storage.getState().applySettings({ ...settingsDefaults, machineAdministrationTargetsLocalV1: {
        [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts]: { serverIdentityId: 'srv_reset_admission', machineId: machine.id },
    } }, 1);
    storage.getState().applyMachines([machine], true, { sourceServerId: active.serverId });
    storage.setState({ isDataReady: true });
    // Socket RPC is the external effect; target resolution and the consume operation remain real.
    const rpc = vi.spyOn(apiSocket, 'machineRPC').mockResolvedValue({ ok: true,
        receipt: { idempotencyKey: 'reset-receipt', status: 'consumed' }, snapshot: null });
    let applied = false;
    const hook = await renderHook(() => useAccountUsageResetAction({ legacyServiceId: 'openai-codex', accountId: 'work',
        machineId, snapshotFetchedAtMs: 1, onApplied: () => { applied = true; } }));
    try {
        await act(async () => { await hook.getCurrent().use(null); });
        expect(rpc).not.toHaveBeenCalled();
        expect(applied).toBe(false);
    } finally { await hook.unmount(); await account.dispose(); bridge.dispose(); storage.getState().clearProfileScope(); }
});
