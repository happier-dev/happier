import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useManagedMachineInventory } from './useManagedMachineInventory';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

installApprovalCommonModuleMocks();
afterEach(() => { retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });

describe('managed Machine inventory', () => {
    it('keeps Ask-first list and saved-resource reads pending until the real approval settles, and retains rows after rejection', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-inventory-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_inventory_approval');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const machine = { id: 'pending', homeId: 'srv_inventory_approval', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const settings = { actionsSettingsV1: { v: 1, actions: {
            'machines.managed.list': { approvalRequiredSurfaces: ['ui'] },
            'machines.managed.get': { approvalRequiredSurfaces: ['ui'] },
        } } };
        const reads: string[] = [];
        setRuntimeFetch(async (raw, init) => {
            const path = new URL(String(raw)).pathname;
            const artifact = artifacts.handle(path, init);
            if (artifact) return artifact;
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/machines/managed/actions/list') { reads.push('list'); return Response.json({ machines: [machine] }); }
            if (path === '/v1/machines/managed/actions/get') { reads.push('get'); return Response.json(machine); }
            return Response.json({ error: 'unexpected_route' }, { status: 404 });
        });
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(({ id }: { id?: string }) => useManagedMachineInventory([target.id], id, execute),
            { initialProps: {}, flushOptions: { cycles: 20 } });
        const pending = () => {
            const entry = hook.getCurrent().entries.srv_inventory_approval;
            expect(entry).toMatchObject({ status: 'loading', approval: { artifactId: expect.any(String) } });
            if (!entry?.approval || typeof entry.approval === 'string') throw new Error('Expected a result-bearing read continuation');
            return entry.approval;
        };
        const settle = async (registration: ActionApprovalContinuation, decision: 'approve' | 'reject') => {
            await expect(decideApprovalAsInbox(target.id, registration.artifactId, decision)).resolves.toMatchObject({ ok: true });
            const account = await captureLazyActionAccountContext(target.id);
            try {
                const artifact = await account.fetchArtifact(registration.artifactId);
                if (!artifact) throw new Error('Expected the persisted approval');
                await act(async () => { if (decision === 'approve') await registration.onExecuted(artifact);
                    else registration.onTerminal?.('rejected', artifact); });
            } finally { account.dispose(); }
            await flushHookEffects({ cycles: 20 });
        };
        const listApproval = pending();
        expect(reads).toEqual([]);
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        await settle(listApproval, 'approve');
        expect(hook.getCurrent().entries.srv_inventory_approval).toMatchObject({ status: 'ready', machines: [{ id: 'pending' }] });
        expect(hook.getCurrent().entries.srv_inventory_approval?.approval).toBeUndefined();
        expect(reads).toEqual(['list']);
        await hook.rerender({ id: machine.id });
        await flushHookEffects({ cycles: 20 });
        const getApproval = pending();
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        await settle(getApproval, 'approve');
        expect(hook.getCurrent().entries.srv_inventory_approval).toMatchObject({ status: 'ready', machines: [{ id: 'pending' }] });
        expect(reads).toEqual(['list', 'get']);
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        const rejected = pending();
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        await settle(rejected, 'reject');
        expect(hook.getCurrent().entries.srv_inventory_approval).toMatchObject({ status: 'error', errorCode: 'approval_rejected', machines: [{ id: 'pending' }] });
        expect(hook.getCurrent().entries.srv_inventory_approval?.approval).toBeUndefined();
        expect(reads).toEqual(['list', 'get']);
        await hook.unmount();
    });

    it('retains rows through network failure, then removes protected content after current access refusal', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-inventory.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_inventory');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        let reply: 'row' | 'unavailable' | 'unsupported' | 'denied' = 'row';
        const machine = { id: 'pending', homeId: 'srv_inventory', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            enrolledMachineId: 'joined-machine' };
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (reply === 'unavailable') throw new Error('network_unavailable');
            if (reply === 'unsupported') return new Response('Not found', { status: 404 });
            if (reply === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            return Response.json({ machines: [machine] });
        });
        // The real executor bypasses only Metro's module loader, not Action policy or Account capture.
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(() => useManagedMachineInventory([target.id], undefined, execute), { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().entries.srv_inventory?.status).toBe('ready');
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        expect(hook.getCurrent()).toMatchObject({ machinesByEnrolledMachineIdByServerId: {
            [target.id]: { 'joined-machine': { id: 'pending' } },
        } });
        reply = 'unavailable';
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        reply = 'unsupported';
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'pending' }]);
        expect(hook.getCurrent().entries.srv_inventory?.status).toBe('unsupported');
        reply = 'denied';
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        expect(hook.getCurrent()).toMatchObject({ machinesByEnrolledMachineIdByServerId: { [target.id]: {} } });
        await hook.unmount();
    });

    it('does not fetch protected inventory or spin forever for a signed-out Home', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://signed-out-inventory.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_signed_out');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        const network = vi.fn(async () => Response.json({ machines: [] }));
        setRuntimeFetch(network);
        const hook = await renderHook(() => useManagedMachineInventory([target.id]), { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        expect(hook.getCurrent().loading).toBe(false);
        expect(network).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not retain the previous resource while a different saved destination is being read', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-target-switch.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_switch');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const machine = { id: 'first', homeId: 'srv_switch', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'First resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'may-exist', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const second = createDeferred<Response>();
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            return JSON.parse(String(init?.body)).managedId === 'second' ? second.promise : Response.json(machine);
        });
        const execute = createDefaultActionExecutor().execute;
        const hook = await renderHook(({ id }: { id: string }) => useManagedMachineInventory([target.id], id, execute),
            { initialProps: { id: 'first' }, flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'first' }]);
        await hook.rerender({ id: 'second' });
        expect(hook.getCurrent().machinesByServerId[target.id]).toEqual([]);
        await act(async () => second.resolve(Response.json({ ...machine, id: 'second', launch: { ...machine.launch, name: 'Second resource' } })));
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().machinesByServerId[target.id]).toMatchObject([{ id: 'second' }]);
        await hook.unmount();
    });
});
