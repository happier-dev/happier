import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storage';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { ManagedMachineDetail } from './ManagedMachineDetail';
import { t } from '@/text';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { ManagedCreationProgress } from './ManagedCreationProgress';
import { ManagedEnrolledMachineSections, useManagedMachineHeaderIdentity, type ManagedMachineHeaderIdentity } from './ManagedMachineSections';
import { ManagedMachinePolicySection, ManagedMachineControllerSection, ManagedControllerMoveList, ManagedMachineRecipeSection } from './ManagedMachineDetailSections';
import { MachineConfigurationReceipt } from './MachineConfigurationReceipt';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
    ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { resolveHref } from 'expo-router/build/link/href';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import sodium from 'libsodium-wrappers';
import { ACTION_OPERATION_RPC_METHODS_V2, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import { readOriginalAccountActionMachine, readOriginalAccountActionAuthentication } from '@/sync/api/externalActionAccountTransport';
import { Modal } from '@/modal';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const operationRpcBoundary = vi.hoisted(() => ({ answer: null as unknown,
    requests: [] as Array<Readonly<{ serverId?: string | null; accountId?: string | null; machineId: string; method: string }>> }));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
vi.mock('@/text', async () => await vi.importActual<typeof import('@/text')>('@/text'));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async params => {
        operationRpcBoundary.requests.push({ serverId: params.serverId, accountId: params.accountId, machineId: params.machineId, method: params.method });
        return operationRpcBoundary.answer ?? { items: [], nextCursor: null };
    });
});
afterEach(() => {
    retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks();
    vi.unstubAllGlobals();
    operationRpcBoundary.answer = null; operationRpcBoundary.requests = []; actionOperationStore.reset();
});

describe('managed Machine detail', () => {
    it.each(['saved', 'enrolled'] as const)('presents retained credential accounts from the captured Home profile and metadata rows while another Home is focused (%s)', async surface => {
        const browserStorage = installLocalStorageMock();
        const browserLocks = installWebLockManagerMock();
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const target = await upsertAndActivateServer({ serverUrl: 'https://credential-receipt-a.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(target.serverUrl, 'srv_credential_receipt_a');
            const tokenA = createAccountTokenForTests('receipt-owner-a', { currentAccount: true });
            expect(await TokenStorage.setCredentialsForServerUrl(target.serverUrl, { serverId: target.id }, { token: tokenA })).toBe(true);
            const focused = await upsertAndActivateServer({ serverUrl: 'https://credential-receipt-b.test', scope: 'tab' });
            await setServerProfileIdentityForUrl(focused.serverUrl, 'srv_credential_receipt_b');
            const tokenB = createAccountTokenForTests('receipt-owner-b', { currentAccount: true });
            expect(await TokenStorage.setCredentialsForServerUrl(focused.serverUrl, { serverId: focused.id }, { token: tokenB })).toBe(true);
            const service = { pluginId: 'custom.retained-accounts', localId: 'compute' };
            const accountId = 'opaque-retained-account';
            const account = { ref: { service, accountId }, status: 'connected' as const, authenticationModeId: 'manual',
                revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false,
                configurationRevision: null, displayName: 'A provider name', scopes: [] };
            const focusedScope = { serverId: resolveServerProfileScopeIdForIdentifier(focused.id), accountId: 'receipt-owner-b' };
            storage.getState().activateProfileScope(focusedScope);
            storage.getState().applyProfile({ ...profileDefaults, id: focusedScope.accountId, connectedAccountsV4: [{ ...account, displayName: 'Ambient B account' }] });
            const provider = { pluginId: 'custom.receipt-provisioner', localId: 'vm' };
            const machine: ManagedMachineV1 = { id: 'receipt-resource', homeId: 'srv_credential_receipt_a', custodianAccountId: 'receipt-owner-a',
                launch: { provider, credentials: [{ purpose: { consumer: provider, purpose: 'native-compute' }, account: account.ref }],
                    schemaVersion: 1, name: 'Retained guest', choices: {} }, controller: { machineId: 'controller', installationId: 'installation' },
                allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                ...(surface === 'enrolled' ? { enrolledMachineId: 'enrolled-receipt-machine' } : {}) };
            const profileReads: string[] = [];
            setRuntimeFetch(async (input, init) => {
                const url = new URL(String(input));
                const targetHome = url.origin === target.serverUrl;
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${targetHome ? tokenA : tokenB}`);
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (url.pathname === '/v1/account/entity-rows/connected-metadata/presentation') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [
                        { v: 1, subject: { kind: 'account', account: account.ref }, label: targetHome ? 'Work on Home A' : 'Personal on Home B' },
                    ] } },
                });
                if (url.pathname === '/v1/account/entity-rows/connected-metadata/acknowledgements') return Response.json({
                    status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [] } },
                });
                if (url.pathname === '/v1/account/profile') {
                    profileReads.push(url.origin);
                    return Response.json({ ...profileDefaults, id: targetHome ? 'receipt-owner-a' : 'receipt-owner-b',
                        connectedAccountsV4: [{ ...account, displayName: targetHome ? 'A provider name' : 'Ambient B account' }] });
                }
                if (url.pathname === '/v1/machines/managed/actions/get') { expect(targetHome).toBe(true); return Response.json(machine); }
                if (url.pathname === '/v1/machines/managed/actions/list') { expect(targetHome).toBe(true); return Response.json({ machines: [machine] }); }
                return Response.json({ error: 'not_found' }, { status: 404 });
            });
            screen = await renderScreen(surface === 'saved' ? <ManagedMachineDetail managedId={machine.id} serverId={target.id}
                executeAction={createDefaultActionExecutor().execute} /> : <ManagedEnrolledMachineSections enrolledMachineId="enrolled-receipt-machine"
                    serverId={target.id} executeAction={createDefaultActionExecutor().execute} />);
            await flushHookEffects({ cycles: 30 });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen!.tree.findByType(MachineConfigurationReceipt).props.model.facts).toEqual(expect.arrayContaining([
                    expect.objectContaining({ id: 'credential:0', value: expect.stringContaining('Work on Home A') }),
                ]));
            });
            const receipt = screen.tree.findByType(MachineConfigurationReceipt).props.model;
            expect(receipt.name).toBe('Retained guest');
            expect(receipt.facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'credential:0', value: expect.stringContaining('Work on Home A') })]));
            expect(profileReads.length).toBeGreaterThan(0);
            expect(profileReads.every(origin => origin === target.serverUrl)).toBe(true);
            const visible = JSON.stringify(receipt.facts);
            expect(visible).not.toContain('Ambient B account');
            expect(visible).not.toContain('Personal on Home B');
            expect(visible).not.toContain(accountId);
            expect(storage.getState().profile.id).toBe(focusedScope.accountId);
            expect(storage.getState().profile.connectedAccountsV4[0]?.displayName).toBe('Ambient B account');
        } finally { await screen?.unmount(); browserLocks.restore(); browserStorage.restore(); }
    });
    it('offers resource custodian Move candidates to a shared manager and revalidates custody before dispatch', async () => {
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(19));
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-shared-move.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_shared_move');
        const token = createAccountTokenForTests('manager', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const controller = { machineId: 'shared-original', installationId: 'shared-original-installation' };
        const destination = { machineId: 'custodian-destination', installationId: 'custodian-destination-installation' };
        const requesterOwned = { machineId: 'requester-owned', installationId: 'requester-owned-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const rows = [controller, destination, requesterOwned].map(row => createMachineFixture({ id: row.machineId,
            installationId: row.installationId, updatedAt: Date.now(), access: {
                custodian: { accountId: row === requesterOwned ? 'manager' : 'resource-owner', displayName: 'Custodian' },
                role: 'manage', resourceMode: 'plain', accessState: 'ready',
            } }));
        storage.setState({ machineListByServerId: { [serverId]: rows } });
        const provider = { pluginId: 'custom.shared-move', localId: 'vm' };
        const credentials = ['compute', 'desktop'].map(purpose => ({ purpose: { consumer: provider, purpose },
            account: { service: { pluginId: 'custom.accounts', localId: purpose }, accountId: `${purpose}-account` } }));
        const machine: ManagedMachineV1 = { id: 'shared-managed', homeId: 'srv_managed_shared_move', custodianAccountId: 'resource-owner',
            launch: { provider, credentials: credentials.map(credential => ({ ...credential, configurationRevision: 'reviewed-config' })),
                schemaVersion: 1, name: 'Shared guest', choices: {} }, controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'retained-shared-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 5, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', descriptor: {
            id: 'vm', title: 'Guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const checked: unknown[] = [];
        const moves: unknown[] = [];
        const actionIds = ['machines.provisioners.list', 'machines.provisioners.check', 'machines.managed.controller.update'] as const;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-shared-move.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === '/v1/machines') return Response.json(rows.map(row => ({
                ...createPlainMachineRowFixture({ id: row.id, accountId: row.access!.custodian.accountId }),
                access: row.access, installationId: row.installationId, installationPublicKey: encodeBase64(installation.publicKey, 'base64'),
            })));
            const mintAction = actionIds.find(actionId => url.pathname === bindExternalActionExecutionAuthorizationHttpPathV1(actionId));
            if (mintAction) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (request.envelope.target.kind !== 'machine') throw new Error('Expected a native controller');
                const machineId = request.envelope.target.machineId;
                const row = rows.find(row => row.id === machineId)!;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'shared-native-authorization', binding: {
                    accountId: 'manager', authentication, serverIdentityId: machine.homeId, machineId: row.id,
                    custodianAccountId: row.access!.custodian.accountId, installationId: row.installationId, accountEncryptionMode: 'plain',
                    actionId: mintAction, requestId: request.envelope.requestId, target: request.envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } }));
            }
            const actionId = actionIds.find(actionId => url.pathname === `/v1/actions/${actionId}`);
            if (actionId) {
                const body: unknown = JSON.parse(String(init?.body));
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
                const request = carrier.success ? carrier.data.envelope : ExternalActionRequestEnvelopeV1Schema.parse(body);
                if (actionId === 'machines.provisioners.check') checked.push(request.input);
                if (actionId === 'machines.managed.controller.update') moves.push(request.input);
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.check' ? { available: true }
                        : { kind: 'approval_request_created', artifactId: 'shared-move-approval', actionId };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 30 });
        const move = screen.tree.findByType(ManagedMachineControllerSection).props.controller.move;
        expect(move.kind).toBe('movable');
        await act(async () => move.onPress());
        await flushHookEffects({ cycles: 30 });
        const candidates = screen.tree.findByType(ManagedControllerMoveList).props.candidates;
        expect(candidates.find((row: { id: string }) => row.id === destination.machineId)?.reachable).toBe(true);
        expect(candidates.find((row: { id: string }) => row.id === requesterOwned.machineId)?.reachable).toBe(false);
        expect(checked).toContainEqual({ homeId: machine.homeId, controller: destination, contribution: provider, credentials });
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: rows.map(row => row.id === destination.machineId
            ? { ...row, access: { ...row.access!, custodian: { accountId: 'manager', displayName: 'Manager' } } } : row) } }));
        await act(async () => screen.tree.findByType(ManagedControllerMoveList).props.onMove(destination.machineId));
        await flushHookEffects({ cycles: 10 });
        expect(moves).toEqual([]);
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: rows } }));
        await act(async () => screen.tree.findByType(ManagedControllerMoveList).props.onMove(destination.machineId));
        await flushHookEffects({ cycles: 20 });
        expect(moves).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 5,
            controller: destination, reviewedPendingEffects: true }]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toEqual(machine);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
    });
    it('reloads the canonical moved controller after native binding repair fails, without replaying Move or applying failure details locally', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-move-partial.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_move_partial');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'partial-original', installationId: 'partial-original-installation' };
        const destination = { machineId: 'partial-destination', installationId: 'partial-destination-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [controller, destination].map(row => createMachineFixture({
            id: row.machineId, installationId: row.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })) } });
        const provider = { pluginId: 'custom.partial', localId: 'vm' };
        const credential = { purpose: { consumer: provider, purpose: 'native-compute' },
            account: { service: { pluginId: 'custom.credentials', localId: 'cloud' }, accountId: 'partial-account' } };
        const desktopCredential = { purpose: { consumer: provider, purpose: 'desktop-control' },
            account: { service: { pluginId: 'custom.credentials', localId: 'desktop' }, accountId: 'partial-desktop-account' } };
        const publicCredentials = [credential, desktopCredential];
        const machine: ManagedMachineV1 = { id: 'partial-resource', homeId: 'srv_managed_move_partial', custodianAccountId: 'owner',
            launch: { provider, credentials: [
                { ...credential, configurationRevision: 'cloud-config-3' },
                { ...desktopCredential, configurationRevision: 'desktop-config-7' },
            ], schemaVersion: 1, name: 'Guest', choices: {} }, controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'original-paid-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 5, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const moved = { ...machine, controller: destination, intentRevision: 6 };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', descriptor: {
            id: 'vm', title: 'Guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const submitted: unknown[] = [];
        const credentialChecks: unknown[] = [];
        let currentMachine = machine;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-move-partial.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'owner',
                connectedAccountsV4: publicCredentials.map((selected, index) => ({ ref: selected.account,
                    status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null,
                    displayName: index === 0 ? 'Cloud Work account' : 'Desktop Work account', scopes: [] })) });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(currentMachine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                if (actionId === 'machines.provisioners.check') credentialChecks.push(request.input);
                if (actionId === 'machines.managed.controller.update') {
                    submitted.push(request.input);
                    currentMachine = moved;
                    return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: false,
                        errorCode: 'managed_binding_move_incomplete', error: 'managed_binding_move_incomplete',
                        details: { machine: { ...moved, intentRevision: 999 }, code: 'scope_binding_refused' } } });
                }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] } : { available: true };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 30 });
        await act(async () => screen.tree.findByType(ManagedMachineControllerSection).props.controller.move.onPress());
        await flushHookEffects({ cycles: 30 });
        const reachable = screen.tree.findByType(ManagedControllerMoveList).props.candidates
            .find((row: { id: string }) => row.id === destination.machineId);
        expect(reachable.subtitle).toContain('Cloud Work account');
        expect(reachable.subtitle).toContain('Desktop Work account');
        expect(reachable.subtitle).not.toContain(credential.account.accountId);
        expect(reachable.subtitle).not.toContain(desktopCredential.account.accountId);
        expect(credentialChecks).toContainEqual({ homeId: machine.homeId, controller: destination, contribution: provider,
            credentials: publicCredentials });
        await act(async () => screen.tree.findByType(ManagedControllerMoveList).props.onMove(destination.machineId));
        await flushHookEffects({ cycles: 35 });
        expect(submitted).toHaveLength(1);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error'
            && node.props.diagnosticCode === 'managed_binding_move_incomplete').length).toBeGreaterThan(0);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toMatchObject({ controller: destination, intentRevision: 6, resource: machine.resource });
    });
    it('consumes an executed ordinary native read approval without refreshing away its fresh policy parent or asking again', async () => {
        await sodium.ready;
        const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(7));
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-parent-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_parent_approval');
        const token = createAccountTokenForTests('owner', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const controller = { machineId: 'parent-controller', installationId: 'parent-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId, installationId: controller.installationId })] } });
        const provider = { pluginId: 'custom.parent', localId: 'vm' };
        const machine: ManagedMachineV1 = { id: 'parent-resource', homeId: 'srv_managed_parent_approval', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} }, controller,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', descriptor: {
            id: 'vm', title: 'Guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const reads: string[] = [];
        let currentMachine = machine;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            const artifactResponse = artifacts.handle(url.pathname, init);
            if (artifactResponse) return artifactResponse;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(currentMachine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                if (envelope.target?.kind !== 'machine') throw new Error('Expected the captured native controller target');
                reads.push(actionId);
                if (actionId === 'machines.provisioners.list') {
                    // This genuine daemon HTTP boundary publishes the current ordinary UI origin.
                    // Admission and Home-token verification stay outside the mounted UI process.
                    const authorization = { v: 1 as const, token: 'native-daemon-authorization', binding: {
                        accountId: 'owner', authentication, serverIdentityId: machine.homeId,
                        machineId: controller.machineId, custodianAccountId: 'owner', installationId: controller.installationId,
                        actionId: 'machines.provisioners.list' as const, requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    } };
                    const request = StoredApprovalRequestSchema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
                        createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId, actionArgs: envelope.input, summary: 'Read available provisioners',
                        decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 2, ok: true, result: { provisioners: [provisioner] } },
                        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' }, serverId: target.id,
                            serverIdentityId: machine.homeId, accountId: 'owner', machineId: controller.machineId, target: envelope.target,
                            actionId, requestId: envelope.requestId, externalActionExecutionAuthorization: authorization,
                            externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                                actionId, input: envelope.input, target: envelope.target, privateKey: installationKey.privateKey }) } });
                    const account = await captureLazyActionAccountContext(target.id);
                    let artifactId: string;
                    try { artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
                    finally { account.dispose(); }
                    return Response.json({ v: 1, requestId: envelope.requestId, actionId,
                        execution: { ok: true, result: { kind: 'approval_request_created', artifactId, actionId } } });
                }
                if (actionId === 'machines.managed.retention.update') {
                    currentMachine = { ...machine, intentRevision: 3, retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true };
                    return Response.json({ v: 1, requestId: envelope.requestId, actionId, execution: { ok: true, result: currentMachine } });
                }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] } : { available: true };
                return Response.json({ v: 1, requestId: envelope.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 50 });
        expect(artifacts.list()).toHaveLength(1);
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifacts.list()[0]!.id) ?? 'null'))).toMatchObject({
            status: 'executed', actionId: 'machines.provisioners.list', execution: { ok: true, result: { provisioners: [provisioner] } },
            executionOriginV1: { surface: 'ui', authority: 'present_user', accountId: 'owner', serverIdentityId: machine.homeId,
                externalActionExecutionAuthorization: { binding: { machineId: controller.machineId, installationId: controller.installationId } } },
        });
        expect(reads.filter(id => id === 'machines.provisioners.list')).toHaveLength(1);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
        await act(async () => screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange({
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
        }));
        await flushHookEffects({ cycles: 50 });
        expect(reads.filter(id => id === 'machines.managed.retention.update')).toHaveLength(1);
        expect(reads.filter(id => id === 'machines.provisioners.list')).toHaveLength(2);
        expect(artifacts.list()).toHaveLength(2);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject({ intentRevision: 3 });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
    });
    it('discloses the fresh finite native expiry without offering creation-duration changes on the live resource', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-finite-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_finite');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'finite-controller', installationId: 'finite-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId, installationId: controller.installationId })] } });
        const provider = { pluginId: 'custom.finite', localId: 'guest' };
        const machine: ManagedMachineV1 = { id: 'finite-resource', homeId: 'srv_managed_finite', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Finite guest', choices: { duration: 'original-duration' } }, controller,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false };
        const provisioner = { contribution: provider, occurrenceId: 'finite-occurrence', descriptor: {
            id: 'guest', title: 'Finite guest', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
            retention: { supportedIntents: ['delete'], finiteOnly: true, nativeExpiry: { kind: 'unused', afterMs: 7_200_000 } },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] } : { available: true };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 25 });
        const keep = screen.tree.findByType(ManagedMachinePolicySection).props.keep;
        expect(keep.finiteOnly).toBe(true);
        expect(keep.nativeExpiry).toBeDefined();
        expect(keep.nativeDuration).toBeUndefined();
        expect(keep.policy.retention).toEqual(machine.retention);
    });
    it.each([
        { allocation: 'confirmed-absent', consoleUrl: undefined },
        { allocation: 'may-exist', consoleUrl: undefined },
        { allocation: 'bound', consoleUrl: undefined },
        { allocation: 'bound', consoleUrl: 'https://console.vendor.test/resources/exact-native-id' },
    ] as const)('reviews manual responsibility before removing a $allocation resource and retains recovery during Ask ($consoleUrl)', async ({ allocation, consoleUrl }) => {
        const openConsole = vi.fn();
        vi.stubGlobal('open', openConsole);
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-retire-review.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_retire');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'retire-controller', installationId: 'retire-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId,
            installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })] } });
        const provider = { pluginId: 'custom.compute', localId: 'guest' };
        const machine: ManagedMachineV1 = { id: 'ended-resource', homeId: 'srv_managed_retire', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Ended guest', choices: {} }, controller,
            allocation, creationState: 'canceled', desired: 'delete', desiredWhen: 'now', intentRevision: 7,
            ...(allocation === 'may-exist' ? {
                nativeOperationRef: { contributionRef: provider, schemaVersion: 1, value: { operationId: 'unknown-native-submission' } },
                recovery: { reference: 'original-native-recovery', reason: 'submission_result_unknown' },
            } : { resource: { contributionRef: provider, schemaVersion: 1,
                value: { nativeId: 'original-native-id', cloud: 'native-cloud', region: 'native-region' } },
                ...(allocation === 'bound' ? { cleanup: { disposition: 'unavailable' as const, reason: 'native_records_missing' },
                    recovery: { reference: 'original-native-id · native-cloud · native-region', reason: 'native_records_missing',
                        ...(consoleUrl ? { consoleUrl } : {}) } } : {}) }),
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const retired: unknown[] = [];
        const nativeActions: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-retire-review.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                nativeActions.push(actionId);
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                if (actionId === 'machines.managed.retire') retired.push(request.input);
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [] }
                    : { kind: 'approval_request_created', artifactId: 'retire-approval', actionId };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 25 });
        const consoleAction = screen.findByTestId('managed-machine.progress:openProvider');
        if (machine.recovery) expect(screen.getTextContent()).toContain(machine.recovery.reference);
        if (consoleUrl) {
            expect(consoleAction).not.toBeNull();
            await act(async () => screen.pressByTestId('managed-machine.progress:openProvider'));
            expect(openConsole).toHaveBeenCalledWith(consoleUrl, '_blank', 'noopener,noreferrer');
        } else {
            expect(consoleAction).toBeNull();
            if (allocation === 'bound') expect(screen.findByTestId('managed-machine.recovery-manual')).not.toBeNull();
        }
        expect(retired).toEqual([]);
        const remove = screen.tree.findAll(node => ['managed-machine.progress:remove', 'managed-machine.remove'].includes(node.props?.testID)
            && typeof node.props.onPress === 'function')[0];
        expect(remove).toBeDefined();
        await act(async () => remove!.props.onPress());
        await flushHookEffects({ cycles: 10 });
        expect(retired).toEqual([]);
        const confirm = screen.tree.findAll(node => node.props?.testID === 'managed-machine.remove-confirm' && typeof node.props.onPress === 'function')[0];
        expect(confirm).toBeDefined();
        await act(async () => confirm!.props.onPress());
        await flushHookEffects({ cycles: 20 });
        expect(retired).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 7, manualResponsibility: true }]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.creationState).toBe('canceled');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.recovery').length).toBeGreaterThan(0);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toEqual(machine);
        if (allocation !== 'confirmed-absent') expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.possible-cost').length).toBeGreaterThan(0);
        expect(nativeActions).not.toContain('machines.managed.delete');
        expect(nativeActions).not.toContain('machines.managed.inspect');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
    });
    it.each(['offline', 'missing', 'missing-local', 'missing-nonmanager'] as const)('offers Move only with current authority and a same-credential destination (%s)', async controllerState => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-move-candidates.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_move');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests(
            controllerState === 'missing-nonmanager' ? 'viewer' : 'owner', { currentAccount: true }) });
        const controller = { machineId: 'original', installationId: 'original-installation' };
        const next = { machineId: 'reachable', installationId: 'reachable-installation' };
        const blocked = { machineId: 'blocked', installationId: 'blocked-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        const location = controllerState === 'missing-local' ? 'local' : 'cloud';
        storage.setState({ machineListByServerId: { [serverId]: (controllerState === 'offline' ? [controller, next, blocked] : [next, blocked]).map(row => createMachineFixture({
            id: row.machineId, installationId: row.installationId, updatedAt: Date.now(),
            ...(row.machineId === controller.machineId ? { active: false, activeAt: 1 } : {}),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })) } });
        const provider = { pluginId: 'custom.compute', localId: 'vm' };
        const credential = { purpose: { consumer: provider, purpose: 'native-compute' },
            account: { service: { pluginId: 'custom.credentials', localId: 'cloud' }, accountId: 'same-cloud-account' } };
        const launch: ManagedMachineV1['launch'] = { provider, credentials: [credential], schemaVersion: 1, name: 'Managed cloud', choices: {} };
        const machine: ManagedMachineV1 = { id: 'move-managed', homeId: 'srv_managed_move', custodianAccountId: 'owner', launch,
            controller, allocation: 'bound', creationState: 'active', resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            desired: 'start', desiredWhen: 'now', intentRevision: 9, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location, stoppedBilling: 'billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const provisioner = { contribution: provider, occurrenceId: 'occurrence', descriptor: {
            id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location, stoppedBilling: 'billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        const checked: unknown[] = [];
        const moves: unknown[] = [];
        const moveTargets: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-move-candidates.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                if (request.target?.kind === 'machine' && request.target.machineId === controller.machineId) {
                    return Response.json({ error: 'target_unavailable', code: 'target_unavailable', requestId: request.requestId }, { status: 409 });
                }
                if (actionId === 'machines.provisioners.check') checked.push(request.input);
                if (actionId === 'machines.managed.controller.update') { moves.push(request.input); moveTargets.push(request.target); }
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.check' ? { available: request.target.kind === 'machine' && request.target.machineId !== blocked.machineId }
                        : { kind: 'approval_request_created', artifactId: 'move-approval', actionId };
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true, result } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 30 });
        if (controllerState === 'missing-local' || controllerState === 'missing-nonmanager') {
            expect(screen.findByTestId('managed-machine.controller-unavailable:move')).toBeNull();
            expect(screen.tree.findAllByType(ManagedControllerMoveList)).toHaveLength(0);
            expect(moves).toEqual([]);
            return;
        }
        const move = controllerState === 'missing'
            ? { kind: 'movable', onPress: () => screen.pressByTestId('managed-machine.controller-unavailable:move') }
            : screen.tree.findByType(ManagedMachineControllerSection).props.controller.move;
        if (controllerState === 'missing') expect(screen.findByTestId('managed-machine.controller-unavailable:move')).not.toBeNull();
        expect(move.kind).toBe('movable');
        expect(checked).toContainEqual({ homeId: machine.homeId, controller: next, contribution: provider, credentials: [credential] });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeDefined();
        await act(async () => move.onPress());
        await flushHookEffects({ cycles: 30 });
        const list = screen.tree.findByType(ManagedControllerMoveList);
        const reachable = list.props.candidates.find((candidate: { id: string; reachable: boolean }) => candidate.reachable && !candidate.id.includes('original'));
        expect(reachable).toBeDefined();
        expect(reachable.subtitle).not.toContain(credential.account.accountId);
        expect(reachable.subtitle).toContain(screen.tree.findByType(MachineConfigurationReceipt).props.model.facts
            .find((fact: { id: string; value: string }) => fact.id === 'credential:0').value);
        expect(list.props.candidates.find((candidate: { id: string; reachable: boolean }) => candidate.id.includes('blocked'))?.reachable).toBe(false);
        expect(checked).toContainEqual({ homeId: machine.homeId, controller: next, contribution: provider, credentials: [credential] });
        await act(async () => list.props.onMove(reachable.id));
        await flushHookEffects({ cycles: 20 });
        expect(moves).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 9, controller: next, reviewedPendingEffects: true }]);
        expect(moveTargets).toEqual([{ kind: 'machine', machineId: next.machineId }]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.controller).toEqual(controller);
    });
    it.each(['controller', 'guest'] as const)('requires the exact shared controller Manage grant for manual Delete, not guest Manage (%s)', async authority => {
        await sodium.ready;
        const installation = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(11));
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-delete-review.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_delete');
        await upsertAndActivateServer({ serverUrl: 'https://other-managed-delete.test', scope: 'tab' });
        const token = createAccountTokenForTests('owner', { currentAccount: true });
        const authentication = readOriginalAccountActionAuthentication(token);
        expect(authentication).toEqual({ kind: 'account', tokenEpoch: 0 });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const launch: ManagedMachineV1['launch'] = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Paid guest', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Foreign owner' },
                role: authority === 'controller' ? 'manage' : 'use', resourceMode: 'plain', accessState: 'ready' },
        }), ...(authority === 'guest' ? [createMachineFixture({ id: 'guest', installationId: 'guest-installation', updatedAt: Date.now(),
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Foreign owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        })] : [])] } });
        const machine: ManagedMachineV1 = { id: 'delete-reviewed', homeId: 'srv_managed_delete', custodianAccountId: 'foreign-owner', launch,
            controller, allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'original-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 8, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'running', storage: 'retained' },
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const nativeRequests: unknown[] = [];
        const minted: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>> = [];
        const authorizations: Array<ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>> = [];
        const nativeCarriers: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>> = [];
        const plainControllerRow = createPlainMachineRowFixture({ id: controller.machineId, accountId: 'foreign-owner' });
        const controllerRow = { ...plainControllerRow,
            access: { custodian: { accountId: 'foreign-owner', displayName: 'Foreign owner' },
                role: authority === 'controller' ? 'manage' : 'use', resourceMode: 'plain', accessState: 'ready' },
            installationId: controller.installationId, installationPublicKey: encodeBase64(installation.publicKey, 'base64') };
        expect(readMachineInstallationPublicKey(controllerRow.installationPublicKey)).toEqual(installation.publicKey);
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-delete-review.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines') return Response.json([controllerRow]);
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname === bindExternalActionExecutionAuthorizationHttpPathV1('machines.managed.delete')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                minted.push(request);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'test-native-issuer-authorization', binding: {
                    accountId: 'owner', authentication, serverIdentityId: machine.homeId,
                    machineId: controller.machineId, custodianAccountId: 'foreign-owner', installationId: controller.installationId,
                    accountEncryptionMode: 'plain', actionId: 'machines.managed.delete', requestId: request.envelope.requestId,
                    target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } });
                authorizations.push(authorization);
                return Response.json(authorization);
            }
            if (url.pathname === '/v1/actions/machines.managed.delete') {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                nativeCarriers.push(request);
                nativeRequests.push(request.envelope);
                return Response.json({ v: 1, requestId: request.envelope.requestId, actionId: 'machines.managed.delete', execution: { ok: true,
                    result: { kind: 'approval_request_created', artifactId: 'delete-approval', actionId: 'machines.managed.delete' } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const account = await captureLazyActionAccountContext(target.id);
        try {
            account.assertCurrent();
            expect({ authority: account.credentialAuthorityKind, homeId: account.serverIdentityId, accountId: account.accountId,
                authentication: readOriginalAccountActionAuthentication(account.credentials.token) })
                .toEqual({ authority: 'account', homeId: machine.homeId, accountId: 'owner', authentication });
            expect(await readOriginalAccountActionMachine(account, controller.machineId)).toMatchObject({
                id: controller.machineId, kind: 'persistent', installationId: controller.installationId, installationPublicKey: installation.publicKey,
                revokedAt: null, replacedByMachineId: null,
                access: { custodian: { accountId: 'foreign-owner' }, accessState: 'ready', role: authority === 'controller' ? 'manage' : 'use' },
            });
        } finally { account.dispose(); }
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId="guest" serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 20 });
        const remove = screen.tree.findAll(node => node.props?.testID === 'managed-machine.delete' && typeof node.props.onPress === 'function')[0];
        expect(remove).toBeDefined();
        if (authority === 'guest') {
            expect(remove?.props.disabled).toBe(true);
            expect(nativeRequests).toEqual([]);
            return;
        }
        expect(remove?.props.disabled).not.toBe(true);
        await act(async () => remove!.props.onPress());
        await flushHookEffects({ cycles: 25 });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.delete-coverage' && node.props.diagnosticCode).length).toBeGreaterThan(0);
        expect(nativeRequests).toEqual([]);
        const confirm = screen.tree.findAll(node => node.props?.testID === 'managed-machine.delete-confirm' && typeof node.props.onPress === 'function')[0];
        expect(confirm).toBeDefined();
        // The decision is one closing button row: the button names it, so no row repeats "Delete machine".
        expect(screen.findByTestId('managed-machine.delete-decision')).not.toBeNull();
        expect(screen.findByTestId('managed-machine.delete-decision.cancel')).not.toBeNull();
        expect(screen.tree.findAll(node => node.props?.title === t('managedMachines.actions.deleteMachine') && node.props?.mode === 'info')).toHaveLength(0);
        await act(async () => confirm!.props.onPress());
        await flushHookEffects({ cycles: 20 });
        await expect(vi.mocked(Modal.confirm).mock.results.at(-1)?.value).resolves.toBe(true);
        expect(minted).toHaveLength(1);
        expect(authorizations[0]?.binding).toMatchObject({ accountId: 'owner', serverIdentityId: machine.homeId, authentication,
            machineId: controller.machineId, installationId: controller.installationId, custodianAccountId: 'foreign-owner',
            target: { kind: 'machine', machineId: controller.machineId }, actionId: 'machines.managed.delete',
            requestId: minted[0]?.envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(minted[0]!.envelope) });
        expect(nativeCarriers[0]?.executionAuthorization).toMatchObject({ binding: authorizations[0]?.binding,
            requesterAccountContext: { kind: 'installation_sealed_v1', installationId: controller.installationId } });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.control-error').map(node => node.props.diagnosticCode)).toEqual([]);
        expect(nativeRequests).toEqual([expect.objectContaining({ input: { homeId: machine.homeId, managedId: machine.id,
            when: 'now', expectedRevision: 8, intent: 'delete', reviewedDependencies: true } })]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.observation.availability).toBe('present');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
    });
    it('resets live Keep from the fresh descriptor and Account parent instead of the immutable creation receipt', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-reset-parent.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_reset');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'controller', installationId: 'installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId, installationId: controller.installationId })] } });
        const launch: ManagedMachineV1['launch'] = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Old receipt', choices: {} };
        const machine: ManagedMachineV1 = { id: 'reset-managed', homeId: 'srv_managed_reset', custodianAccountId: 'owner', launch,
            controller, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, desired: 'start', desiredWhen: 'now',
            intentRevision: 6, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'billed' },
                prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const provisioner = { contribution: launch.provider, occurrenceId: 'fresh-occurrence', descriptor: {
            id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'not-billed' },
            retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } };
        let afterMs = 3_600_000;
        const nativeRequests: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-reset-parent.test');
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                machineRetentionDefaultsV1: { v: 1, 'running-only': { retention: { kind: 'unused', effect: 'stop', afterMs }, wakeOnAcceptedMessage: true } },
            } }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname.startsWith('/v1/actions/')) {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                const actionId = url.pathname.slice('/v1/actions/'.length);
                if (actionId === 'machines.managed.retention.update') nativeRequests.push(request);
                const result = actionId === 'machines.provisioners.list' ? { provisioners: [provisioner] }
                    : actionId === 'machines.provisioners.check' ? { available: true }
                        : { kind: 'approval_request_created', artifactId: 'reset-approval', actionId };
                return Response.json({ v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } });
            }
            if (url.pathname.startsWith('/v1/artifacts/')) return Response.json({ error: 'not_found' }, { status: 404 });
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 30 });
        const keep = screen.tree.findByType(ManagedMachinePolicySection).props.keep;
        expect(keep.defaultPolicy).toMatchObject({ retention: { kind: 'unused', afterMs }, wakeOnAcceptedMessage: true });
        expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.cost).toEqual({ kind: 'unpriced', provider: 'Virtual machine' });
        afterMs = 7_200_000;
        await act(async () => keep.onReset());
        await flushHookEffects({ cycles: 30 });
        expect(nativeRequests).toEqual([expect.objectContaining({ input: { homeId: machine.homeId, managedId: machine.id,
            expectedIntentRevision: 6, retention: { kind: 'unused', effect: 'stop', afterMs }, wakeOnAcceptedMessage: true } })]);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy.retention).toEqual({ kind: 'until-delete' });
    });
    it('reads a failed native bootstrap from the current controller after enrollment and retries only that retained resource during Ask', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-enrolled-bootstrap.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_enrolled_bootstrap');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const controller = { machineId: 'boot-controller', installationId: 'boot-installation' };
        const serverId = resolveServerProfileScopeIdForIdentifier(target.id) || target.id;
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({
            id: controller.machineId, installationId: controller.installationId, updatedAt: Date.now(),
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        })] } });
        const provider = { pluginId: 'custom.native', localId: 'guest' };
        const machine: ManagedMachineV1 = { id: 'boot-managed', homeId: 'srv_enrolled_bootstrap', custodianAccountId: 'owner',
            launch: { provider, schemaVersion: 1, name: 'Enrolled guest', choices: {} }, controller,
            enrolledMachineId: 'enrolled-guest', allocation: 'bound', creationState: 'active',
            resource: { contributionRef: provider, schemaVersion: 1, value: { nativeId: 'same-paid-resource' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const failed: ActionOperationSnapshotV1 = { version: 1, operationId: 'boot-failure', revision: 2,
            actionId: 'machines.managed.bootstrap.retry', state: 'failed', scope: { accountId: 'owner', machineId: controller.machineId },
            title: 'Create managed machine', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported',
            error: { errorCode: 'native_boot_unconfirmed', error: 'Native boot configuration was not confirmed' },
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller } };
        operationRpcBoundary.answer = { items: [failed], nextCursor: null };
        const retries: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-enrolled-bootstrap.test');
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/list') return Response.json({ machines: [machine] });
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json(machine);
            if (url.pathname.startsWith('/v1/actions/')) {
                const actionId = url.pathname.slice('/v1/actions/'.length);
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                if (actionId === 'machines.managed.bootstrap.retry') retries.push(request.input);
                return Response.json({ v: 1, requestId: request.requestId, actionId, execution: { ok: true,
                    result: actionId === 'machines.provisioners.list' ? { provisioners: [] }
                        : { kind: 'approval_request_created', artifactId: 'boot-retry-approval', actionId } } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId="enrolled-guest" serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 30 });
        expect(operationRpcBoundary.requests).toContainEqual({ serverId, accountId: 'owner', machineId: controller.machineId,
            method: ACTION_OPERATION_RPC_METHODS_V2.list });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error'
            && node.props.diagnosticCode === 'native_boot_unconfirmed').length).toBeGreaterThan(0);
        const retry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
            && typeof node.props.onPress === 'function')[0];
        expect(retry).toBeDefined();
        await act(async () => retry!.props.onPress());
        await flushHookEffects({ cycles: 20 });
        expect(retries).toEqual([{ homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 4 }]);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine).toMatchObject({
            enrolledMachineId: 'enrolled-guest', intentRevision: 4, resource: machine.resource, controller });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
    });
    it('shows only the observed installer stage and offers retry only for an explicit failed installation task', async () => {
        const machine: ManagedMachineV1 = { id: 'installer-managed', homeId: 'installer-home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Installing guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'existing' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const snapshot: import('@happier-dev/protocol/actions/operations/v1').ActionOperationSnapshotV1 = {
            version: 1, operationId: 'installer-operation', revision: 1, actionId: 'machines.managed.acquire', state: 'running',
            scope: { accountId: 'owner', machineId: 'controller' }, title: 'Create managed machine', createdAt: 1, startedAt: 2,
            progress: { kind: 'phase', phase: 'ssh_installing', label: 'Installing Happier' }, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, resource: machine.resource, controller: machine.controller,
                bootstrapTask: { id: 'bootstrap', taskKind: 'remote.ssh.bootstrapMachine.v1' } },
        };
        const retried: unknown[] = [];
        const operation = { serverId: machine.homeId, snapshot, observation: 'available' as const, isUnavailableProjection: false };
        const screen = await renderScreen(<ManagedCreationProgress {...{ machine, operation,
            handlers: { reinstall: () => retried.push(machine.resource?.value) } }} />);
        const installing = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation' && node.props.subtitle)[0];
        expect(installing?.props.subtitle).toBe('Installing Happier');
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine,
            operation: { ...operation, snapshot: { ...snapshot, revision: 2, state: 'failed' as const, settledAt: 3,
                error: { errorCode: 'bootstrap_failed', error: 'Installer exited without completing' } } },
            handlers: { reinstall: () => retried.push(machine.resource?.value) } }} />));
        const retry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry' && typeof node.props.onPress === 'function')[0];
        expect(retry).toBeDefined();
        await act(async () => retry!.props.onPress());
        expect(retried).toEqual([{ resourceId: 'existing' }]);
        const failed = { ...operation, snapshot: { ...snapshot, revision: 2, state: 'failed' as const, settledAt: 3,
            error: { errorCode: 'bootstrap_failed', error: 'Installer exited without completing' } } };
        const enrolled = { ...machine, enrolledMachineId: 'installed-guest' };
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: enrolled,
            operation: { ...failed, snapshot: { ...failed.snapshot,
                error: { errorCode: 'native_boot_unconfirmed', error: 'Native boot configuration failed after enrollment' } } },
            handlers: { reinstall: () => retried.push('same-enrolled-resource') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error'
            && node.props.diagnosticCode === 'native_boot_unconfirmed').length).toBeGreaterThan(0);
        const enrolledRetry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
            && typeof node.props.onPress === 'function')[0];
        expect(enrolledRetry).toBeDefined();
        await act(async () => enrolledRetry!.props.onPress());
        expect(retried).toEqual([{ resourceId: 'existing' }, 'same-enrolled-resource']);
        const bootRetry = { ...failed, snapshot: { ...failed.snapshot, operationId: 'boot-retry',
            actionId: 'machines.managed.bootstrap.retry' as const,
            domainRef: { kind: 'managedMachine' as const, id: machine.id, controller: machine.controller, resource: machine.resource },
            error: { errorCode: 'native_boot_unconfirmed', error: 'Native boot configuration remains unconfirmed' } } };
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: enrolled, operation: bootRetry,
            handlers: { reinstall: () => retried.push('same-boot-retry-resource') } }} />));
        const repeatedRetry = screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry'
            && typeof node.props.onPress === 'function')[0];
        expect(repeatedRetry).toBeDefined();
        await act(async () => repeatedRetry!.props.onPress());
        expect(retried).toEqual([{ resourceId: 'existing' }, 'same-enrolled-resource', 'same-boot-retry-resource']);
        const { error: _bootError, ...successfulBoot } = bootRetry.snapshot;
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: enrolled,
            operation: { ...bootRetry, snapshot: { ...successfulBoot, revision: 3, state: 'succeeded' as const } },
            handlers: { reinstall: () => retried.push('after-boot-success') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-error').length).toBe(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: { ...machine,
            submittedNativeEffect: { intentRevision: 2, requestId: 'delete-current', intent: 'delete', controller: machine.controller } }, operation: failed,
            handlers: { reinstall: () => retried.push('while-deleting') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: { ...machine,
            observation: { observedAt: 4, availability: 'absent' } }, operation: failed,
            handlers: { reinstall: () => retried.push('after-absence') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: { ...machine,
            resource: { ...machine.resource!, value: { resourceId: 'replacement' } } }, operation: failed,
            handlers: { reinstall: () => retried.push('wrong-resource') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation').length).toBe(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine: { ...machine,
            controller: { ...machine.controller, installationId: 'replacement-installation' } }, operation: failed,
            handlers: { reinstall: () => retried.push('wrong-installation') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation').length).toBe(0);
        await act(async () => screen.tree.update(<ManagedCreationProgress {...{ machine,
            operation: { ...operation, snapshot: { ...snapshot, revision: 2, state: 'failed' as const, settledAt: 3,
                domainRef: { kind: 'managedMachine' as const, id: machine.id },
                error: { errorCode: 'allocation_failed', error: 'Resource creation failed' } } },
            handlers: { reinstall: () => retried.push('wrong') } }} />));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.installation-retry').length).toBe(0);
    });
    it('reviews a supported Start on the same stopped resource in the saved Home before native dispatch', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-start-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_start');
        await upsertAndActivateServer({ serverUrl: 'https://other-managed-start.test', scope: 'tab' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const launch: ManagedMachineV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Stopped resource', choices: {} };
        const machine: ManagedMachineV1 = { id: 'start-existing', homeId: 'srv_managed_start', custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'same-native' } },
            desired: 'stop', desiredWhen: 'now', intentRevision: 4, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 2, power: 'stopped', storage: 'retained' },
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'cloud', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const nativeRequests: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-start-approval.test');
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/actions/machines.managed.power.set') {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                nativeRequests.push(request);
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId,
                    actionId: 'machines.managed.power.set', execution: { ok: true,
                        result: { kind: 'approval_request_created', artifactId: 'controller-start-approval', actionId: 'machines.managed.power.set' } } }));
            }
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 20 });
        const start = screen.tree.findAll(node => node.props?.testID === 'managed-machine.start' && typeof node.props.onPress === 'function')[0];
        expect(start).toBeDefined();
        await act(async () => start!.props.onPress());
        await flushHookEffects({ cycles: 20 });
        expect(nativeRequests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' },
            input: { homeId: machine.homeId, managedId: machine.id, when: 'now', expectedRevision: 4, intent: 'start' } })]);
        expect(artifacts.list()).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.start' && node.props.disabled === true).length).toBeGreaterThan(0);
        expect(screen.tree.findByType(ManagedCreationProgress).props.machine.observation.power).toBe('stopped');
    });
    it('keeps an Ask-first policy Action pending in the ordinary approval owner without applying its policy', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-policy-approval.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_managed_policy_approval');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner', { currentAccount: true }) });
        const machine: ManagedMachineV1 = { id: 'ask-policy', homeId: 'srv_managed_policy_approval', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Ask resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const nativeRequests: unknown[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-policy-approval.test');
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.retention.update': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/actions/machines.managed.retention.update') {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
                nativeRequests.push(request);
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, requestId: request.requestId,
                    actionId: 'machines.managed.retention.update', execution: { ok: true,
                        result: { kind: 'approval_request_created', artifactId: 'controller-policy-approval', actionId: 'machines.managed.retention.update' } } }));
            }
            expect(url.pathname).toBe('/v1/machines/managed/actions/get');
            return Response.json(machine);
        });
        const screen = await renderScreen(<ManagedMachineDetail managedId={machine.id} serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 20 });
        await act(async () => screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange({
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
        }));
        await flushHookEffects({ cycles: 20 });
        expect(nativeRequests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' },
            input: { homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: 1,
                retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true } })]);
        expect(artifacts.list()).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.approval').length).toBeGreaterThan(0);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject({
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
        });
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.disabled).toBe(true);
    });
    it('mounts the enrolled association with the immutable receipt and removes it on read refusal', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://enrolled-managed-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_enrolled_detail');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const launch: ManagedMachineV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'Original recipe', choices: { cpu: 4, image: 'captured-image' } };
        const machine: ManagedMachineV1 = { id: 'managed-enrolled', homeId: 'srv_enrolled_detail', custodianAccountId: 'owner', launch,
            controller: { machineId: 'new-controller', installationId: 'new-installation' }, enrolledMachineId: 'ordinary-enrolled',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: { resourceId: 'original-native' } },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            reviewedFacts: { launch, controller: { machineId: 'original-controller', installationId: 'original-installation' },
                optionStatus: 'current', billing: { location: 'cloud', stoppedBilling: 'not-billed' }, prerequisites: [],
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                nativeFacts: { size: { id: 'captured-size', title: 'Four-core guest', cpuCores: 4 },
                    image: { id: 'captured-image', title: 'Original Linux image', description: 'Long-term support' },
                    location: { id: 'captured-location', title: 'Original region', countryCode: 'DE' } },
                prices: [{ amount: '0.125', currency: 'USD', unit: 'hour', source: 'captured-price', observedAt: 5 }] } };
        const receiptController = createMachineFixture({ id: 'original-controller', installationId: 'original-installation',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Original controller computer' } });
        storage.getState().applyMachines([receiptController], true, { sourceServerId: resolveServerProfileScopeIdForIdentifier(target.id) });
        let denied = false;
        setRuntimeFetch(async input => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://enrolled-managed-detail.test');
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            expect(url.pathname).toBe('/v1/machines/managed/actions/list');
            return denied ? Response.json({ code: 'permission_denied' }, { status: 403 }) : Response.json({ machines: [machine] });
        });
        const screen = await renderScreen(<ManagedEnrolledMachineSections enrolledMachineId="ordinary-enrolled" serverId={target.id}
            executeAction={createDefaultActionExecutor().execute} />);
        await flushHookEffects({ cycles: 20 });
        const receipt = screen.tree.findByType(MachineConfigurationReceipt);
        expect(receipt.props.model).toMatchObject({ name: 'Original recipe', cost: { kind: 'price', prices: machine.reviewedFacts!.prices } });
        expect(receipt.props.model.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'controller', value: 'Original controller computer' }),
        ]));
        // The live Keep it sits beside the receipt; a creation-time policy row there would contradict it.
        expect(receipt.props.model.facts.map((fact: { id: string }) => fact.id)).not.toContain('retention');
        expect(receipt.props.model.keep).toBeUndefined();
        // The size and its labelled native dimensions are the receipt's spec line (RV-C F13).
        expect(receipt.props.model.spec).toBe(`Four-core guest · ${t('managedMachines.receipt.cores', { count: 4 })}`);
        // Stop and Delete sit at the receipt's foot, beside the cost they change.
        expect(receipt.props.model.secondary?.map((action: { testID?: string }) => action.testID))
            .toEqual(['managed-machine.start', 'managed-machine.stop', 'managed-machine.delete']);
        expect(screen.tree.findByType(ManagedMachineRecipeSection).props.rows).toEqual([
            expect.objectContaining({ id: 'size', title: 'Four-core guest', subtitle: t('managedMachines.receipt.cores', { count: 4 }) }),
            // Each value's own fact, never the category word ("Image", "Location") again.
            expect.objectContaining({ id: 'image', title: 'Original Linux image', subtitle: 'Long-term support' }),
            expect.objectContaining({ id: 'location', title: 'Original region', subtitle: expect.stringMatching(/ · captured-location$/) }),
        ]);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy').length).toBeGreaterThan(0);
        const controller = createMachineFixture({ id: machine.controller.machineId,
            installationId: machine.controller.installationId, activeAt: Date.now() });
        const machineSource = { sourceServerId: resolveServerProfileScopeIdForIdentifier(target.id) };
        await act(async () => storage.getState().applyMachines([controller], true, machineSource));
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.controller').length).toBeGreaterThan(0);
        await act(async () => storage.getState().applyMachines([{ ...controller, installationId: 'replacement-installation',
            seq: controller.seq + 1, updatedAt: controller.updatedAt + 1 }], true, machineSource));
        // Online presence for a same-id replacement does not prove the required installation is available.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.controller')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.controller-unavailable').length).toBeGreaterThan(0);
        const savedPolicy = { retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage };
        await act(async () => screen.tree.findByType(ManagedMachinePolicySection).props.keep.onChange({
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        }));
        await flushHookEffects({ cycles: 20 });
        // A refused ordinary Action is not an applied policy, even while the retained revision is unchanged.
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.policy).toMatchObject(savedPolicy);
        expect(screen.tree.findByType(ManagedMachinePolicySection).props.keep.defaultPolicy).toBeUndefined();
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy.keep:reset'
            && node.props.disabled === true).length).toBeGreaterThan(0);
        denied = true;
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.policy')).toHaveLength(0);
        await act(async () => storage.getState().applyMachines([], true, machineSource));
    });
    it('names a created machine in its header by where it came from and its observed power, never by a guess', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-header-identity.test', scope: 'tab' });
        setRuntimeFetch(async () => Response.json({ error: 'not_found' }, { status: 404 }));
        const launch: ManagedMachineV1['launch'] = { provider: { pluginId: 'custom.provisioner', localId: 'native' },
            schemaVersion: 1, name: 'hz-build-2', choices: {} };
        const machine: ManagedMachineV1 = { id: 'managed-identity', homeId: 'srv_identity', custodianAccountId: 'owner', launch,
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'enrolled',
            resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, allocation: 'bound', creationState: 'active',
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', observedAt: 1, power: 'running' },
            reviewedFacts: { launch, controller: { machineId: 'controller', installationId: 'installation' }, optionStatus: 'current',
                billing: { location: 'cloud', stoppedBilling: 'billed' }, prerequisites: [], retentionCapabilities: { supportedIntents: ['stop'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, preset: { id: 'build', revision: 3, name: 'Build box' } } };
        const seen: Array<ManagedMachineHeaderIdentity | null> = [];
        function Probe(props: Readonly<{ machine?: ManagedMachineV1 }>) {
            seen.push(useManagedMachineHeaderIdentity(props.machine, target.id));
            return null;
        }
        const screen = await renderScreen(<Probe machine={machine} />);
        expect(seen.at(-1)?.description).toBe(t('managedMachines.detail.madeFromPreset', { preset: 'Build box' }));
        expect(seen.at(-1)?.meta).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'managed-power', text: t('managedMachines.detail.power.running') })]));
        // Unknown power says nothing rather than "Running" on a guess.
        await screen.update(<Probe machine={{ ...machine, observation: { availability: 'unavailable', observedAt: 2 } }} />);
        expect(seen.at(-1)?.meta.some(fact => fact.key === 'managed-power')).toBe(false);
        await screen.update(<Probe />);
        expect(seen.at(-1)).toBeNull();
    });
    it('does not imply continuing billing after confirmed absence, even with a retained cleanup marker', async () => {
        const screen = await renderScreen(<ManagedCreationProgress machine={{ id: 'absent', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Ended resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'confirmed-absent', creationState: 'canceled',
            cleanup: { disposition: 'pending', reason: 'previous_cleanup' }, desired: 'delete', desiredWhen: 'now', intentRevision: 2,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }} />);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.possible-cost')).toHaveLength(0);
    });
    it('offers Retry setup and Continue without setup on a failed Set up of this same joined machine (D53)', async () => {
        const machine: ManagedMachineV1 = { id: 'setup-failed', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native' } },
            preset: { id: 'preset', revision: 2 }, environmentSetup: { environment: { setupScript: 'npm ci' }, state: 'failed', errorCode: 'setup_failed' },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        const retry = vi.fn();
        const skip = vi.fn();
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} setupRecovery={{ retry, skip }} />);
        for (const testID of ['managed-machine.setup-retry', 'managed-machine.setup-skip']) {
            await act(async () => screen.tree.findAll(node => node.props?.testID === testID && typeof node.props.onPress === 'function')[0]!.props.onPress());
        }
        expect(retry).toHaveBeenCalledTimes(1);
        expect(skip).toHaveBeenCalledTimes(1);
        const succeeded = await renderScreen(<ManagedCreationProgress machine={{ ...machine,
            environmentSetup: { environment: { setupScript: 'npm ci' }, state: 'succeeded' } }} setupRecovery={{ retry, skip }} />);
        expect(succeeded.tree.findAll(node => node.props?.testID === 'managed-machine.setup')).toHaveLength(0);
    });
    it('does not present an enrolled healthy Machine as still awaiting its Happier connection', async () => {
        const machine: ManagedMachineV1 = { id: 'enrolled-healthy', homeId: 'home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Enrolled resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'ordinary-machine',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native' } },
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: 5, availability: 'present', power: 'running', storage: 'retained', daemon: 'connected' } };
        const screen = await renderScreen(<ManagedCreationProgress machine={machine} />);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.progress')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.recovery').length).toBeGreaterThan(0);
        const stopped = await renderScreen(<ManagedCreationProgress machine={{ ...machine,
            observation: { ...machine.observation!, power: 'stopped' } }} />);
        expect(stopped.tree.findAll(node => node.props?.testID === 'managed-machine.progress').length).toBeGreaterThan(0);
    });
    it('reads the saved Home, clears refused content, and hands verified enrollment to the ordinary Machine route', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://managed-detail.test', scope: 'tab' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_detail');
        await upsertAndActivateServer({ serverUrl: 'https://other-focused.test', scope: 'tab' });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('owner') });
        const machine = { id: 'pending', homeId: 'srv_detail', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Retained resource', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
            resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { resourceId: 'native-id' } },
            desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        let state: 'pending' | 'denied' | 'enrolled' = 'pending';
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://managed-detail.test');
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            expect(JSON.parse(String(init?.body))).toEqual({ homeId: 'srv_detail', managedId: 'pending' });
            if (state === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            return Response.json({ ...machine, ...(state === 'enrolled' ? { enrolledMachineId: 'machine-joined' } : {}) });
        });
        const executeAction = createDefaultActionExecutor().execute;
        const screen = await renderScreen(<ManagedMachineDetail managedId="pending" serverId={target.id} executeAction={executeAction} />);
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.progress').length).toBeGreaterThan(0);
        // A bound unenrolled row alone is not evidence that installation failed or is retryable.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.retry-install')).toHaveLength(0);
        // An unpriced retained resource still has a creation receipt; absence of a price is not a hidden recipe.
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.detail.receipt:cost').length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.detail.receipt:keep')).toHaveLength(0);
        state = 'denied';
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.progress')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props?.testID === 'managed-machine.cancel')).toHaveLength(0);
        state = 'enrolled';
        await act(async () => publishHomeAccountChange(target.id));
        await flushHookEffects({ cycles: 20 });
        const redirect = screen.tree.findByType('Redirect' as never);
        expect(resolveHref(redirect.props.href)).toBe(`/machine/machine-joined?serverId=${encodeURIComponent(target.id)}`);
    });
});
