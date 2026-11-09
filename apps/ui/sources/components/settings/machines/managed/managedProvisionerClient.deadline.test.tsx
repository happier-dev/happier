import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createManagedControllerMachineFixture, createMachineProvisionerOptionsFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

installApprovalCommonModuleMocks();
const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');

afterEach(async () => {
    await standardCleanup();
    vi.useRealTimers();
    resetRuntimeFetch();
    vi.restoreAllMocks();
});

describe('managed catalog request lifetime', () => {
    it('keeps slow Account preparation and dispatch within the caller lifetime', async () => {
        const serverUrl = 'https://catalog-preparation.example.test';
        const homeId = 'srv_catalog_preparation';
        await upsertServerProfile({ serverUrl, name: 'Catalog Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, {
            token: createAccountTokenForTests('catalog-owner', { currentAccount: true }),
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        let preparationIssued!: () => void;
        const preparing = new Promise<void>(resolve => { preparationIssued = resolve; });
        let dispatchIssued!: () => void;
        const dispatched = new Promise<void>(resolve => { dispatchIssued = resolve; });
        let releasePreparation!: () => void;
        let requestSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') {
                const pending = new Promise<void>(resolve => { releasePreparation = resolve; });
                preparationIssued();
                await pending;
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path !== '/v1/actions/machines.provisioners.list') return Response.json({}, { status: 404 });
            requestSignal = init?.signal;
            dispatchIssued();
            return await new Promise<Response>((_resolve, reject) => {
                const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
                init?.signal?.addEventListener('abort', abort, { once: true });
                if (init?.signal?.aborted) abort();
            });
        });
        vi.useFakeTimers();
        const caller = new AbortController();
        const pending = createDefaultActionExecutor().execute('machines.provisioners.list',
            { homeId, controller: { machineId: 'controller', installationId: 'installation' } },
            { serverId: homeId, expectedAccountId: 'catalog-owner', surface: 'ui', authority: 'present_user', actionRequestId: 'preparation-read', signal: caller.signal });
        await preparing;
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
        releasePreparation();
        await dispatched;
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
        expect(requestSignal?.aborted).toBe(false);
        const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        caller.abort();
        expect(requestSignal?.aborted).toBe(true);
        await settled;
    });

    it('keeps a pending controller read alive beyond the RPC default and cancels it on unmount', async () => {
        const serverUrl = 'https://catalog-deadline.example.test';
        const homeId = 'srv_catalog_deadline';
        const token = createAccountTokenForTests('catalog-owner', { currentAccount: true });
        await upsertServerProfile({ serverUrl, name: 'Catalog Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token });
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        await publishMachineInventoryForTest({ serverId: homeId, accountId: 'catalog-owner' }, [createManagedControllerMachineFixture({
            id: 'controller', installationId: 'installation', activeAt: Date.now(), kind: 'persistent',
        })]);
        let issued!: () => void;
        const dispatched = new Promise<void>(resolve => { issued = resolve; });
        let catalogSignal: AbortSignal | null | undefined;
        let reads = 0;
        // Only HTTP is substituted. The real Action, scope, catalog hook and mount lifetime run.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path !== '/v1/actions/machines.provisioners.list') return Response.json({}, { status: 404 });
            reads++;
            catalogSignal = init?.signal;
            issued();
            return await new Promise<Response>((_resolve, reject) => {
                const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
                init?.signal?.addEventListener('abort', abort, { once: true });
                if (init?.signal?.aborted) abort();
            });
        });
        vi.useFakeTimers();
        const screen = await renderScreen(<ListPresentationProvider value="page">
            <MachineProvisionerPicker serverId={homeId} />
        </ListPresentationProvider>);
        await dispatched;
        await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1); });
        expect(catalogSignal?.aborted).toBe(false);
        expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
        await screen.unmount();
        expect(catalogSignal?.aborted).toBe(true);
        expect(reads).toBe(1);
    });

    it('accepts valid reads and acquisition responses beyond the unrelated RPC default', async () => {
        const serverUrl = 'https://catalog-lifetime.example.test';
        const homeId = 'srv_catalog_lifetime';
        const token = createAccountTokenForTests('catalog-owner', { currentAccount: true });
        await upsertServerProfile({ serverUrl, name: 'Catalog Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { executeManagedMachineNativeAction } = await import('@/sync/api/machines/managedMachineOrigination');
        const account = await captureLazyActionAccountContext(homeId);
        let release!: () => void;
        let issued!: () => void;
        let requestSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines') return Response.json([ExternalActionMachineBootstrapV1Schema.parse({ id: 'controller', kind: 'persistent', active: true,
                installationId: 'installation', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                access: { custodian: { accountId: 'catalog-owner', displayName: 'Catalog owner' }, accessState: 'ready', role: 'manage', resourceMode: 'plain' } })]);
            // The controller row is read through the batched Machine reader.
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, machineId => machineId === 'controller'
                ? { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'catalog-owner' }), installationId: 'installation' } : null);
            requestSignal = init?.signal;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const pending = new Promise<void>(resolve => { release = resolve; });
            issued();
            await pending;
            return Response.json({ v: 1, actionId: path.slice('/v1/actions/'.length), requestId: envelope.requestId,
                execution: { ok: true, result: path.endsWith('/machines.provisioners.list')
                    ? { provisioners: [] } : path.endsWith('/machines.provisioners.check')
                        ? { available: true } : path.endsWith('/machines.provisioners.options') ? createMachineProvisionerOptionsFixture()
                            : { kind: 'approval_request_created', artifactId: 'native-approval', actionId: 'machines.managed.acquire' } } });
        });
        vi.useFakeTimers();
        try {
            for (const actionId of ['machines.provisioners.list', 'machines.provisioners.check', 'machines.provisioners.options', 'machines.managed.acquire'] as const) {
                const dispatched = new Promise<void>(resolve => { issued = resolve; });
                const pending = executeManagedMachineNativeAction({ account, actionId,
                    input: actionId === 'machines.managed.acquire'
                        ? { selection: { kind: 'one-off', homeId, controller: { machineId: 'controller', installationId: 'installation' },
                            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
                            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } }
                        : { homeId, controller: { machineId: 'controller', installationId: 'installation' },
                            ...(actionId !== 'machines.provisioners.list' ? { contribution: { pluginId: 'custom.compute', localId: 'vm' } } : {}),
                            ...(actionId === 'machines.provisioners.options' ? { selectors: {} } : {}) },
                    context: { surface: 'ui', authority: 'present_user', actionRequestId: actionId } });
                await Promise.race([dispatched, pending.then(result => {
                    throw new Error(`Action settled before dispatch: ${JSON.stringify(result)}`);
                })]);
                await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1);
                expect(requestSignal?.aborted).toBe(false);
                release();
                expect(await pending).toMatchObject({ ok: true });
            }
        } finally { account.dispose(); }
    });
});
