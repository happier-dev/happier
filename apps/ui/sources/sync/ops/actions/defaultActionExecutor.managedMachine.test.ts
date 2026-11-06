import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import type { ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

installApprovalCommonModuleMocks();
// The census list and the by-id Machine rows reader (a532f4a1e0) answer from the same external rows.
function answerMachineRows(url: URL, init: RequestInit | undefined, rows: unknown): Response {
    if (url.pathname === '/v1/machines') return Response.json(rows);
    const list = Array.isArray(rows) ? rows as ReadonlyArray<{ id: string; access?: { custodian?: { accountId?: string } } }> : [];
    // A by-id read returns a full published row; the census rows here carry only the fields each case is about.
    return createMachineReadBatchResponseFixture(init?.body, id => {
        const row = list.find(candidate => candidate.id === id);
        return row ? { ...createPlainMachineRowFixture({ id, accountId: row.access?.custodian?.accountId ?? 'account-a' }), ...row } : null;
    });
}
beforeAll(loadSyncSingletonForTests);
afterEach(() => { resetRuntimeFetch(); invalidateAccountEncryptionModeCache(); actionOperationStore.reset(); vi.restoreAllMocks(); });

describe('managed native UI Action frontdoor', () => {
    it.each(['execute', 'prepare'] as const)('keeps required Delete approval at the retained controller (%s)', async method => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-delete-approval.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_delete');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        let retainedReads = 0;
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.delete': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') {
                retainedReads++;
                return Response.json({
                id: 'managed-a', homeId: 'srv_native_delete', custodianAccountId: 'account-a',
                controller: { machineId: 'controller-a', installationId: 'installation-a' },
                launch: { provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, value: {} },
                desired: 'stop', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 3,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                });
            }
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, []);
            expect(url.pathname).toBe('/v1/actions/machines.managed.delete');
            const requestId = String((JSON.parse(String(init?.body)) as { requestId: string }).requestId);
            if (method === 'prepare') return Response.json({ v: 1, requestId, actionId: 'machines.managed.delete',
                execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'delete-ask', actionId: 'machines.managed.delete' } } });
            actionOperationStore.mergeSnapshots({ serverId: target.id, snapshots: [ActionOperationSnapshotV1Schema.parse({
                version: 1, operationId: 'delete-operation', requestId, revision: 2,
                actionId: 'machines.managed.delete', state: 'running', scope: { accountId: 'account-a', machineId: 'controller-a' },
                title: 'Delete managed machine', createdAt: 1, startedAt: 2, cancellation: 'supported',
                progress: { kind: 'phase', phase: 'waiting_for_approval', label: 'Waiting for approval',
                    approval: { kind: 'approval_request_created', artifactId: 'delete-ask', actionId: 'machines.managed.delete' } },
            })] });
            return await new Promise<Response>(() => {});
        });
        const executor = createDefaultActionExecutor();
        const input = {
            homeId: 'srv_native_delete', managedId: 'managed-a', when: 'now', expectedRevision: 3,
            intent: 'delete', reviewedDependencies: true,
        };
        const context = { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' as const, authority: 'present_user' as const };
        const execution = method === 'execute' ? executor.execute('machines.managed.delete', input, context)
            : (async () => {
                const prepared = await executor.prepare('machines.managed.delete', input, context);
                return prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
            })();
        expect(await Promise.race([execution, new Promise(resolve => setTimeout(() => resolve('still-pending'), 100))])).toEqual({
            ok: true, result: { kind: 'approval_request_created', artifactId: 'delete-ask', actionId: 'machines.managed.delete' },
        });
        expect(artifacts.list()).toHaveLength(0);
        expect(retainedReads).toBe(1);
    });
    it.each(['foreign', 'use', 'bypass', 'wrong-managed', 'wrong-home'] as const)('preserves Account approval and relay admission refusals (%s)', async relationship => {
        const target = await upsertServerProfile({ serverUrl: `https://managed-delete-${relationship}.test` });
        const homeId = `srv_managed_delete_${relationship}`;
        await setServerProfileIdentityForUrl(target.serverUrl, homeId);
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        const nativeEffects: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.delete': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (url.pathname === '/v1/machines/managed/actions/get') {
                // Home's Manage boundary refuses unrelated Accounts and Use-only members.
                if (relationship === 'foreign' || relationship === 'use') return Response.json({ code: 'permission_denied' }, { status: 403 });
                return Response.json({ id: relationship === 'wrong-managed' ? 'different-managed' : 'managed-a',
                    homeId: relationship === 'wrong-home' ? 'different-home' : homeId, custodianAccountId: 'account-a',
                    controller: { machineId: 'controller-a', installationId: 'installation-a' },
                    launch: { provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, name: 'Guest', choices: {} },
                    resource: { contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1, value: {} },
                    desired: 'stop', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 3,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
            }
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, []);
            nativeEffects.push(url.pathname);
            return Response.json({ code: 'permission_denied' }, { status: 403 });
        });
        const executor = createDefaultActionExecutor();
        const result = await executor.execute('machines.managed.delete', {
            homeId, managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'delete', reviewedDependencies: true,
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
            ...(relationship === 'bypass' ? { bypassApprovals: true } : {}) });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: relationship === 'bypass' ? 'admission_unavailable'
                : relationship === 'wrong-managed' || relationship === 'wrong-home' ? 'managed_response_invalid' : 'permission_denied' });
        expect(artifacts.list()).toHaveLength(0);
        expect(nativeEffects).toEqual([]);
    });
    it.each([
        ['ui', 'machines.provisioners.options'], ['voice', 'machines.provisioners.options'],
        ['ui', 'machines.environment.apply'], ['voice', 'machines.environment.apply'],
    ] as const)(
        'retains %s %s authority through the captured Account ingress', async (surface, actionId) => {
        const target = await upsertServerProfile({ serverUrl: `https://native-${surface}-${actionId.replaceAll('.', '-')}.test` });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_options');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const input = actionId === 'machines.provisioners.options'
            ? { homeId: 'srv_native_options', controller: { machineId: 'controller', installationId: 'installation' },
                contribution: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, selectors: {} }
            : { homeId: 'srv_native_options', machineId: 'controller', presetId: 'preset', presetRevision: 2 };
        const output = actionId === 'machines.provisioners.options'
            ? { choices: [{ id: 'small', title: 'Small', launch: { name: 'guest' } }] }
            : { operationId: 'setup', terminalId: 'setup-terminal' };
        const requests: unknown[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [
                { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account-a' }), runnerContentKeyBinding: null },
            ]);
            expect(url.pathname).toBe(`/v1/actions/${actionId}`);
            expect(new Headers(init?.headers).get(AUTHORITY_CEILING_HEADER_V1)).toBe(surface === 'voice' ? 'account_automation' : null);
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            requests.push(envelope);
            return Response.json({ v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result: surface === 'voice' && actionId === 'machines.environment.apply'
                    ? { kind: 'approval_request_created', actionId, artifactId: 'native-ask' } : output } });
        });
        expect(await createDefaultActionExecutor().execute(actionId, input, {
            serverId: target.id, expectedAccountId: 'account-a', surface,
            ...(surface === 'ui' && actionId === 'machines.environment.apply' ? { presentUserConfirmation: { actionId } } : {}),
        })).toEqual({ ok: true, result: surface === 'voice' && actionId === 'machines.environment.apply'
            ? { kind: 'approval_request_created', actionId, artifactId: 'native-ask' } : output });
        expect(requests).toEqual([expect.objectContaining({ target: { kind: 'machine', machineId: 'controller' }, input })]);
    });

    it('refuses native Voice admission for a terminal credential despite caller-supplied present-user authority', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-voice-terminal.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_voice_terminal');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        setRuntimeFetch(async (rawUrl) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            effects.push(path);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        expect(await createDefaultActionExecutor().execute('machines.provisioners.options', {
            homeId: 'srv_voice_terminal', controller: { machineId: 'controller', installationId: 'installation' },
            contribution: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, selectors: {},
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'voice', authority: 'present_user' }))
            .toEqual({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
        expect(effects).toEqual([]);
    });

    it.each(['own', 'foreign'] as const)('admits Move at the selected destination when the retained controller is unavailable (%s row)', async (ownership) => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-move.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_move');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const current = { machineId: 'current-controller', installationId: 'current-installation' };
        const destination = { machineId: 'destination-controller', installationId: 'destination-installation' };
        const effects: unknown[] = [];
        const input = { homeId: 'srv_native_move', managedId: 'managed-a', expectedIntentRevision: 3,
            controller: destination, reviewedPendingEffects: true as const };
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            // This foreign fixture deliberately has no installed-key discovery;
            // refusal must come from that real missing custody, not a mock assertion.
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, []);
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json({
                id: 'managed-a', homeId: 'srv_native_move', custodianAccountId: ownership === 'own' ? 'account-a' : 'other-account',
                controller: current, launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: {} },
                desired: 'stop', desiredWhen: 'now',
                allocation: 'bound', creationState: 'active', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            });
            expect(url.pathname).toBe('/v1/actions/machines.managed.controller.update');
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            effects.push(envelope);
            return Response.json({ v: 1, actionId: 'machines.managed.controller.update', requestId: envelope.requestId,
                execution: { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.controller.update', artifactId: 'move-ask' } } });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.controller.update', input, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui',
        });
        expect(result).toMatchObject(ownership === 'own' ? { ok: true } : { ok: false });
        expect(effects).toEqual(ownership === 'own' ? [expect.objectContaining({ target: { kind: 'machine', machineId: destination.machineId }, input })] : []);
    });

    it('does not borrow a foreign Manage controller approval owner for keyless Plain acquisition', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-foreign-acquire.test' });
        await setServerProfileIdentityForUrl(target.serverUrl, 'srv_foreign_acquire');
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [{ id: 'foreign-controller', kind: 'persistent', active: false,
                installationId: 'foreign-installation', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                runnerContentKeyBinding: null, access: { custodian: { accountId: 'controller-owner', displayName: 'Owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
            effects.push(url.pathname);
            const envelope = JSON.parse(String(init?.body)) as Readonly<{ requestId: string }>;
            return Response.json({ v: 1, actionId: 'machines.managed.acquire', requestId: envelope.requestId,
                execution: { ok: true, result: { managedId: 'foreign-managed-a' } } });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.acquire', {
            selection: { kind: 'one-off', homeId: 'srv_foreign_acquire',
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'foreign-controller', installationId: 'foreign-installation' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui' });
        expect(result).toMatchObject({ ok: false });
        expect(effects).toEqual([]);
    });

    it('admits keyless Plain acquisition through the captured ordinary Account ingress and retains the offline identity receipt', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-acquire.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_acquire')).toMatchObject({ serverIdentityId: 'srv_native_acquire' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const input = { selection: { kind: 'one-off' as const, homeId: 'srv_native_acquire',
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller-a', installationId: 'installation-a' },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        let admitted = false;
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [{ id: 'controller-a', kind: 'persistent', active: false,
                installationId: 'installation-a', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                runnerContentKeyBinding: null, access: { custodian: { accountId: 'account-a', displayName: 'Owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
            expect(url.pathname).toBe('/v1/actions/machines.managed.acquire');
            expect(JSON.parse(String(init?.body))).toEqual({ v: 1, requestId: 'acquire-offline-a',
                target: { kind: 'machine', machineId: 'controller-a' }, input });
            admitted = true;
            return Response.json({ v: 1, actionId: 'machines.managed.acquire', requestId: 'acquire-offline-a',
                execution: { ok: true, result: { managedId: 'offline-managed-a' } } });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.acquire', input, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user', actionRequestId: 'acquire-offline-a',
        });
        expect(result).toEqual({ ok: true, result: { managedId: 'offline-managed-a' } });
        expect(admitted).toBe(true);
    });

    it('refuses a real Ask-first native Artifact decision when public ingress cannot consume its approval custody', async () => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-approved.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_approved')).toMatchObject({ serverIdentityId: 'srv_native_approved' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            const artifact = artifacts.handle(url.pathname, init);
            if (artifact) return artifact;
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'machines.managed.acquire': { approvalRequiredSurfaces: ['ui'] } } },
            } }, version: 1 });
            if (init?.method === 'POST') effects.push(url.pathname);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const actionArgs = {
            selection: { kind: 'one-off', homeId: 'srv_native_approved',
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'controller-a', installationId: 'installation-a' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        };
        // Exercise replay of an already persisted outer approval. Its real
        // Artifact producer is independent of a new ordinary native request,
        // which now delegates its single Ask to the installed executor.
        const request = StoredApprovalRequestSchema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' },
            requestedSurface: 'ui', actionId: 'machines.managed.acquire', actionArgs, summary: 'Acquire Guest',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId: target.id, accountId: 'account-a', actionId: 'machines.managed.acquire', requestId: 'approved-acquire-a' },
        });
        const account = await captureLazyActionAccountContext(target.id);
        try { await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)); }
        finally { account.dispose(); }
        const stored = artifacts.list();
        expect(stored).toHaveLength(1);
        const result = await executor.execute('approval.request.decide', { artifactId: stored[0].id, decision: 'approve' }, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
        });
        // This Artifact has no exact-daemon replay route. The canonical replay
        // owner refuses before dispatch instead of reconstructing live input.
        expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: { errorCode: 'approval_origin_unavailable' } } });
        expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(stored[0].id) ?? 'null'))).toMatchObject({
            status: 'failed', decision: { kind: 'approve' }, execution: { errorCode: 'approval_origin_unavailable' },
        });
        expect(effects).toEqual([]);
    });

    it.each(['sealed', 'offline', 'uncorrelated', 'downgrade'] as const)('keeps E2EE acquisition whole-action and exposes only genuine correlated custody (%s response)', async (responseKind) => {
        const target = await upsertServerProfile({ serverUrl: `https://native-encrypted-${responseKind}.test` });
        const homeId = `srv_native_e2ee_${responseKind}`;
        expect(await setServerProfileIdentityForUrl(target.serverUrl, homeId)).toMatchObject({ serverIdentityId: homeId });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        const credentials = { token, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        const material = { type: 'dataKey' as const, machineKey: encryption.getContentPrivateKey() };
        const binding = { serverIdentityId: homeId, accountId: 'account-a', authentication: { kind: 'account' as const, tokenEpoch: 3 },
            actionId: 'machines.managed.acquire' as const, requestId: 'encrypted-acquire-a', target: { kind: 'machine' as const, machineId: 'controller-a' } };
        const selection = { kind: 'one-off' as const, homeId,
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller-a', installationId: 'installation-a' }, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const input = { selection, agentStart: { directory: { kind: 'path' as const, path: '/repo' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } },
            creationKey: 'managed-agent-start', initialInput: { text: 'private bootstrap instruction' } } };
        let admitted = false;
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, [{ id: 'controller-a', kind: 'persistent', active: false,
                revokedAt: null, replacedByMachineId: null, installationId: 'installation-a', dataEncryptionKey: null,
                storageMode: 'e2ee', metadata: 'opaque Account ciphertext', metadataVersion: 1, daemonState: null,
                daemonStateVersion: 0, keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 0 },
                runnerContentKeyBinding: null, installationPublicKey: null, contentPublicKeyFingerprint: null,
                operationProtocolCapabilities: null, operationProtocolCapabilitiesRevision: null,
                replacedAt: null, replacementReason: null, replacementSource: null, replacementActorUserId: null,
                seq: 1, activeAt: 1, createdAt: 1, updatedAt: 1,
                access: { custodian: { accountId: 'account-a', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } }]);
            expect(url.pathname).toBe('/v1/actions/machines.managed.acquire');
            expect(String(init?.body)).not.toContain('private bootstrap instruction');
            const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(String(init?.body)));
            expect(envelope.managedAdmission).toEqual({ actionId: 'machines.managed.acquire', input: { selection }, continuationPresent: true });
            expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })).toEqual({ input });
            admitted = true;
            if (responseKind === 'offline' || responseKind === 'uncorrelated') return Response.json({ error: 'invalid_request', code: 'target_unavailable',
                ...(responseKind === 'offline' ? { requestId: binding.requestId } : {}),
                managedAdmission: { managedId: 'offline-managed-a' } }, { status: 409 });
            if (responseKind === 'downgrade') return Response.json({ v: 1, actionId: binding.actionId, requestId: binding.requestId,
                execution: { ok: true, result: { managedId: 'forged-plaintext-id' } } });
            return Response.json(prepareExternalActionResponseV2({ binding, request: envelope, material, randomBytes: getRandomBytes,
                executedMachineId: 'controller-a', execution: { ok: true, result: { managedId: 'sealed-managed-a' } } }).response);
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.acquire', input, {
            serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user', actionRequestId: binding.requestId,
        });
        expect(result).toEqual(responseKind === 'sealed' ? { ok: true, result: { managedId: 'sealed-managed-a' } }
            : responseKind === 'offline' ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
                details: { error: 'invalid_request', code: 'target_unavailable', requestId: binding.requestId, managedAdmission: { managedId: 'offline-managed-a' } } }
            : responseKind === 'uncorrelated' ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
            : { ok: false, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' });
        expect(admitted).toBe(true);
    });
    it.each(['own', 'foreign'] as const)('keeps native approval in its real Account custody (%s controller)', async (ownership) => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-target.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_power')).toMatchObject({ serverIdentityId: 'srv_native_power' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        // Genuine credential-store boundary: current structured provenance, not a legacy Account alias.
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const contribution = { pluginId: 'happier.machine.lima', localId: 'lima' };
        const paths: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            expect(url.origin).toBe(target.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            paths.push(url.pathname);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/artifacts') {
                // Echo the genuine Artifact request so a local Ask is observable, not a setup failure.
                const create = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
                return Response.json({ ...create, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            }
            if (url.pathname === '/v1/machines/managed/actions/get') return Response.json({
                id: 'managed-a', homeId: 'srv_native_power', custodianAccountId: ownership === 'own' ? 'account-a' : 'account-custodian',
                controller: { machineId: 'controller-a', installationId: 'installation-a' },
                launch: { provider: contribution, schemaVersion: 1, name: 'Guest', choices: {} },
                resource: { contributionRef: contribution, schemaVersion: 1, value: {} },
                desired: 'stop', desiredWhen: 'now',
                allocation: 'bound', creationState: 'active', enrolledMachineId: 'stopped-guest-a',
                intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' },
            });
            if (url.pathname === '/v1/machines' || url.pathname === '/v1/machines/read-batch') return answerMachineRows(url, init, { machines: [] });
            expect(url.pathname).toBe('/v1/actions/machines.managed.power.set');
            const envelope: unknown = JSON.parse(String(init?.body));
            expect(envelope).toMatchObject({ v: 1, target: { kind: 'machine', machineId: 'controller-a' },
                input: { homeId: 'srv_native_power', managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'start' } });
            expect(envelope).not.toHaveProperty('authority');
            expect(envelope).not.toHaveProperty('executionAuthorization');
            const requestId = typeof envelope === 'object' && envelope !== null && 'requestId' in envelope ? envelope.requestId : undefined;
            return Response.json({ v: 1, actionId: 'machines.managed.power.set', ...(requestId ? { requestId } : {}),
                execution: { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.power.set', artifactId: 'installed-ask-a' } } });
        });
        const action = await createDefaultActionExecutor().prepare('machines.managed.power.set', {
            homeId: 'srv_native_power', managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'start',
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: 'ui', authority: 'present_user',
            // The foreign case lacks the current installation needed for
            // private Account custody, independently of local Ask.
            ...(ownership === 'foreign' ? { presentUserConfirmation: { actionId: 'machines.managed.power.set' as const } } : {}),
        });
        const result = action.kind === 'settled' ? action.result : await action.invocation.run();
        expect(result).toEqual(ownership === 'own'
            ? { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.managed.power.set', artifactId: 'installed-ask-a' } }
            : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
        if (ownership === 'own') expect(paths).toContain('/v1/actions/machines.managed.power.set');
        else expect(paths).not.toContain('/v1/actions/machines.managed.power.set');
        expect(paths).not.toContain('/v1/artifacts');
    });

    it.each(['agent', 'plugin', 'api'] as const)('does not turn an automation-qualified %s origin into a present-user native relay', async (origin) => {
        const target = await upsertServerProfile({ serverUrl: 'https://native-refusal.test' });
        expect(await setServerProfileIdentityForUrl(target.serverUrl, 'srv_native_origin')).toMatchObject({ serverIdentityId: 'srv_native_origin' });
        await resetPendingQueueState({ serverId: 'server-b', accountId: 'account-b' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'account-a', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const effects: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const url = new URL(String(rawUrl));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (init?.method === 'POST') effects.push(url.pathname);
            return Response.json({ error: 'unsupported' }, { status: 404 });
        });
        const result = await createDefaultActionExecutor().execute('machines.managed.power.set', {
            homeId: 'srv_native_origin', managedId: 'managed-a', when: 'now', expectedRevision: 3, intent: 'start',
        }, { serverId: target.id, expectedAccountId: 'account-a', surface: origin, authority: 'account_automation' });
        expect(result).toMatchObject({ ok: false });
        expect(effects).toEqual([]);
    });
});
