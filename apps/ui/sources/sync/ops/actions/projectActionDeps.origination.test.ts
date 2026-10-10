import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createUiProjectAction } from './projectActionDeps';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { Modal } from '@/modal';

const disclosure = vi.hoisted(() => vi.fn(async () => true));
const createSocket = vi.hoisted(() => vi.fn());
// The network socket factory is the boundary; scoped transport and RPC codecs stay real.
vi.mock('@happier-dev/sync-client', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/sync-client')>(),
    createHappierSocket: (...args: unknown[]) => createSocket(...args),
}));
installApprovalCommonModuleMocks();

describe('original Account finite Project admission', () => {
    it('forwards the existing typed Session write scope through the real socket boundary without Account HTTP admission', async () => {
        const homeId = 'srv_session_finite';
        const serverUrl = 'https://session-finite.example.test';
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'ui-owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Session Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token })).toBe(true);
        const authorization = { kind: 'session.write' as const, sessionId: 'source-session' };
        const result = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
        const calls: unknown[] = [];
        const networkPaths: string[] = [];
        const emitWithAck = async (event: string, value: unknown) => {
            expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
            // Socket.io supplies an untyped wire payload at this genuine network boundary.
            const payload = value as Readonly<{ method: string; params: unknown; authorization?: unknown; requestId?: string }>;
            calls.push(payload);
            expect(payload.requestId).toBe('session-finite-request');
            const opened = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
            return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, opened.callId) };
        };
        createSocket.mockReturnValue({ socket: { connected: true, id: 'session-socket', connect() {}, disconnect() {},
            on() {}, off() {}, emit() {}, emitWithAck, timeout: () => ({ emitWithAck }) } });
        let actionPosts = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            networkPaths.push(path);
            if (path.startsWith('/v1/actions/')) actionPosts += 1;
            expect(init?.method ?? 'GET').toBe('GET');
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines/guest') return Response.json({ machine: { id: 'guest', kind: 'persistent', dataEncryptionKey: null,
                access: { custodian: { accountId: 'ui-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } });
            expect(path).toBe('/v1/auth/ping');
            return Response.json({ ok: true });
        });
        onTestFinished(async () => { await serverScopedRpcSocketPool.stopAll(); resetRuntimeFetch(); });
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        const received = await createUiProjectAction(account)({ actionId: 'projects.prepare',
            input: { workspace: { serverId: homeId, workspaceId: 'checkout', machineId: 'guest', rootPath: '/repo' }, phase: 'setup' },
            context: { surface: 'agent', authority: 'account_automation', actionRequestId: 'session-finite-request',
                actionCaller: { kind: 'session', sessionId: authorization.sessionId, starterDepth: 0, turnDepth: 0 }, rpcSessionAuthorization: authorization } });
        expect(received, JSON.stringify({ networkPaths, socketCreations: createSocket.mock.calls.length, calls })).toEqual(result);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ authorization, requestId: 'session-finite-request' });
        expect(actionPosts).toBe(0);
    });
    it('admits foreign finite execution with private original requester custody rather than the custodian sign-in', async () => {
        disclosure.mockReset().mockResolvedValue(true);
        const confirm = vi.spyOn(Modal, 'confirm').mockImplementation(disclosure);
        onTestFinished(() => confirm.mockRestore());
        const homeId = 'srv_foreign_finite';
        const serverUrl = 'https://foreign-finite.example.test';
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertServerProfile({ serverUrl, name: 'Requester Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token })).toBe(true);
        const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const input = { workspace: { serverId: homeId, workspaceId: 'checkout', machineId: 'alice-guest', rootPath: '/repo' }, phase: 'setup' };
        let originalEnvelope: unknown;
        const result = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            expect(new URL(String(url)).origin).toBe(serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines') return Response.json([{ id: 'alice-guest', kind: 'persistent', active: false,
                installationId: 'alice-installation', installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null,
                replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }]);
            // D24 disclosure belongs to the ordinary share/approval surface;
            // requester transport must not impose another mandatory confirmation.
            expect(disclosure).not.toHaveBeenCalled();
            const body: unknown = JSON.parse(String(init?.body));
            if (path === '/v1/actions/projects.prepare/execution-authorization') {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as Readonly<{ envelope: unknown }>).envelope);
                expect(envelope).toEqual({ v: 1, requestId: 'foreign-finite-request', target: { kind: 'machine', machineId: 'alice-guest' }, input });
                originalEnvelope = envelope;
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-origin', binding: {
                    accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: homeId,
                    machineId: 'alice-guest', installationId: 'alice-installation', custodianAccountId: 'alice', accountEncryptionMode: 'plain',
                    actionId: 'projects.prepare', requestId: envelope.requestId, target: envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } }));
            }
            expect(path).toBe('/v1/actions/projects.prepare');
            expect(body).toMatchObject({ v: 1, machineId: 'alice-guest', envelope: originalEnvelope });
            expect(JSON.stringify(body)).not.toContain(token);
            expect(openExternalActionRequesterAccountContextV1({ authorization: (body as Readonly<{ executionAuthorization: unknown }>).executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: 'alice-guest', installationId: 'alice-installation',
                serverIdentityId: homeId, installationPrivateKey: installation.secretKey })).toEqual({ token });
            return Response.json({ v: 1, actionId: 'projects.prepare', requestId: 'foreign-finite-request', execution: { ok: true, result } });
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        expect(await createUiProjectAction(account)({ actionId: 'projects.prepare', input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: 'foreign-finite-request' } })).toEqual(result);
    });
    it('keeps E2EE input protected on the exact captured Home and rejects an unrelated response', async () => {
        const homeId = 'srv_encrypted_finite';
        const serverUrl = 'https://encrypted-finite.example.test';
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'encrypted-owner', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const keys = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(6));
        await upsertServerProfile({ serverUrl, name: 'Encrypted Finite Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, {
            token, encryption: { publicKey: encodeBase64(keys.publicKey), machineKey: encodeBase64(keys.secretKey) },
        })).toBe(true);
        const input = { workspace: { serverId: homeId, workspaceId: 'checkout', machineId: 'guest', rootPath: '/private-repo' }, phase: 'setup' };
        const material = { type: 'dataKey' as const, machineKey: keys.secretKey };
        const binding = { serverIdentityId: homeId, accountId: 'encrypted-owner', authentication: { kind: 'account' as const, tokenEpoch: 3 },
            actionId: 'projects.prepare' as const, requestId: 'encrypted-request', target: { kind: 'machine' as const, machineId: 'guest' } };
        let wrongResponse = false;
        setRuntimeFetch(async (url, init) => {
            expect(new URL(String(url)).origin).toBe(serverUrl);
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (path === '/v1/machines') return Response.json([{ id: 'guest', kind: 'persistent', active: false, installationId: 'installation',
                revokedAt: null, replacedByMachineId: null, dataEncryptionKey: 'sealed-key', runnerContentKeyBinding: null,
                access: { custodian: { accountId: 'encrypted-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } }]);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            const envelope = ExternalActionRequestEnvelopeV2Schema.parse(request.envelope);
            expect(request.machineId).toBe('guest');
            expect(String(init?.body)).not.toContain('/private-repo');
            if (path === '/v1/actions/projects.prepare/execution-authorization') {
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'encrypted-home-authorization', binding: {
                    ...binding, machineId: 'guest', installationId: 'installation', custodianAccountId: 'encrypted-owner', accountEncryptionMode: 'e2ee',
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } }));
            }
            expect(path).toBe('/v1/actions/projects.prepare');
            expect(request.executionAuthorization).toMatchObject({ token: 'encrypted-home-authorization', binding: {
                ...binding, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } });
            expect(request.executionAuthorization?.requesterAccountContext).toBeUndefined();
            expect(openExternalActionRequestV2({ envelope, binding, material })).toEqual({ input });
            const response = prepareExternalActionResponseV2({ binding, material, request: envelope, executedMachineId: 'guest',
                execution: { ok: true, result: { kind: 'notRequired', reviewedEffectDigest: 'reviewed' } }, randomBytes: length => new Uint8Array(length).fill(8) }).response;
            return Response.json(wrongResponse ? { ...response, requestId: 'unrelated-request' } : response);
        });
        onTestFinished(resetRuntimeFetch);
        const account = await captureLazyActionAccountContext(homeId);
        onTestFinished(() => account.dispose());
        const send = () => createUiProjectAction(account)({ actionId: 'projects.prepare', input,
            context: { surface: 'ui', authority: 'present_user', actionRequestId: binding.requestId } });
        expect(await send()).toEqual({ kind: 'notRequired', reviewedEffectDigest: 'reviewed' });
        wrongResponse = true;
        expect(await send()).toEqual({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    });
    it.each(['projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const)(
        'admits %s at the original Home before the stopped guest can accept work', async (actionId) => {
            const homeId = `srv_finite_${actionId.replaceAll('.', '_')}`;
            const serverUrl = `https://${actionId.replaceAll('.', '-')}.example.test`;
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'finite-owner', tokenEpoch: 2,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            await upsertServerProfile({ serverUrl, name: 'Finite Home' });
            await setServerProfileIdentityForUrl(serverUrl, homeId);
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token })).toBe(true);
            const workspace = { serverId: homeId, workspaceId: 'checkout', machineId: 'sleeping-guest', rootPath: '/repo' };
            const input = actionId === 'projects.prepare' ? { workspace, phase: 'setup' }
                : actionId === 'projects.script.run' ? { workspace, selection: { kind: 'named', name: 'check' }, choice: { kind: 'primary' } }
                : { workspace, executable: 'make', argv: ['check'], cwd: '/repo', choice: { kind: 'primary' } };
            const result = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
            const requests: unknown[] = [];
            setRuntimeFetch(async (url, init) => {
                const parsedUrl = new URL(String(url));
                expect(parsedUrl.origin).toBe(serverUrl);
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
                if (parsedUrl.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (parsedUrl.pathname === '/v1/machines') return Response.json([{ id: workspace.machineId, kind: 'persistent', active: false,
                    installationId: 'guest-installation', revokedAt: null, replacedByMachineId: null,
                    dataEncryptionKey: null, runnerContentKeyBinding: null,
                    access: { custodian: { accountId: 'finite-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }]);
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                expect(request.machineId).toBe(workspace.machineId);
                expect(envelope).toEqual({ v: 1, requestId: 'original-finite-request', target: { kind: 'machine', machineId: workspace.machineId }, input });
                if (parsedUrl.pathname === `/v1/actions/${actionId}/execution-authorization`) {
                    return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-home-authorization', binding: {
                        accountId: 'finite-owner', authentication: { kind: 'account', tokenEpoch: 2 }, serverIdentityId: homeId,
                        machineId: workspace.machineId, installationId: 'guest-installation', custodianAccountId: 'finite-owner', accountEncryptionMode: 'plain',
                        actionId, requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    } }));
                }
                expect(parsedUrl.pathname).toBe(`/v1/actions/${actionId}`);
                expect(request.executionAuthorization).toMatchObject({ token: 'own-home-authorization', binding: {
                    actionId, requestId: envelope.requestId, machineId: workspace.machineId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } });
                expect(request.executionAuthorization?.requesterAccountContext).toBeUndefined();
                expect(init?.signal).toBeDefined();
                requests.push(envelope);
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                    execution: { ok: true, result } }));
            });
            onTestFinished(resetRuntimeFetch);
            const signal = new AbortController().signal;
            const account = await captureLazyActionAccountContext(homeId, signal);
            onTestFinished(() => account.dispose());
            expect(await createUiProjectAction(account)({ actionId, input,
                context: { surface: 'ui', authority: 'present_user', actionRequestId: 'original-finite-request', signal } })).toEqual(result);
            expect(requests).toHaveLength(1);
            if (actionId === 'projects.prepare') {
                expect(await createUiProjectAction(account)({ actionId, input,
                    context: { surface: 'agent', authority: 'account_automation', actionRequestId: 'unbound-hosted-request', signal } }))
                    .toEqual({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
                expect(requests).toHaveLength(1);
            }
        });
});
