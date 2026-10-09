import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const rawRpc = vi.hoisted(() => vi.fn(async () => ({ ok: true, handoffId: 'moved',
    status: { handoffId: 'moved', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } })));
// The Machine network adapter is the boundary. Account capture, admission framing and codecs run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rawRpc }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
afterEach(() => { resetRuntimeFetch(); rawRpc.mockClear(); });
const { startSessionHandoff } = await import('./sessionHandoffs');

describe('human requester handoff transport', () => {
    it.each(['plain', 'e2ee'] as const)('carries the own Session tuple through Home admission on a shared source for %s', async mode => {
        const homeId = `srv_fx14-${mode}`;
        const serverUrl = `https://${homeId}.example.test`;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const profile = await upsertServerProfile({ serverUrl, name: 'Handoff Home' });
        expect(await setServerProfileIdentityForUrl(serverUrl, homeId)).not.toBeNull();
        expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: profile.id }, { token,
            ...(mode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') } : {}) })).toBe(true);
        const installationPublicKey = encodeBase64(nacl.sign.keyPair().publicKey, 'base64');
        const admissions: unknown[] = [];
        const actions: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 1 });
            if (path === '/v1/machines') return Response.json([{ id: 'source', kind: 'persistent', active: true,
                revokedAt: null, replacedByMachineId: null, installationId: 'source-install', installationPublicKey,
                dataEncryptionKey: null, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
                    role: 'use', resourceMode: 'plain', accessState: 'ready' } }]);
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            if (path.includes('/execution-authorization')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                admissions.push(request.envelope);
                return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed', binding: {
                    serverIdentityId: homeId, accountId: 'bob', accountEncryptionMode: mode,
                    authentication: { kind: 'account', tokenEpoch: 1 }, machineId: 'source', custodianAccountId: 'alice',
                    installationId: 'source-install', actionId: 'session.handoff', requestId: request.envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
                    handoffAdmission: { ...request.envelope.handoffAdmission, sourceInstallationId: 'source-install', targetInstallationId: 'target-install' },
                } }));
            }
            if (path === '/v1/actions/session.handoff') {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                actions.push(request);
                if (mode === 'e2ee') return Response.json(ExternalActionHttpErrorSchema.parse({ error: 'invalid_request',
                    code: 'target_unavailable', requestId: request.envelope.requestId }), { status: 409 });
                return Response.json({ v: 1, actionId: 'session.handoff', requestId: request.envelope.requestId,
                    execution: { ok: true, result: { handoffId: 'moved', status: { handoffId: 'moved', status: 'completed',
                        phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } } } });
            }
            throw new Error(`Unexpected boundary: ${path}`);
        });
        const result = await startSessionHandoff({ sessionId: 'bob-session', sourceMachineId: 'source',
            targetMachineId: 'target', serverId: profile.id, actionRequestId: 'human-handoff' });
        expect(admissions, JSON.stringify(result)).toHaveLength(1);
        expect(admissions[0]).toMatchObject({ handoffAdmission: {
            sessionId: 'bob-session', sourceMachineId: 'source', targetMachineId: 'target' } });
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({ executionAuthorization: { token: 'home-signed', binding: {
            accountId: 'bob', custodianAccountId: 'alice', installationId: 'source-install' } } });
        expect(rawRpc).not.toHaveBeenCalled();
        expect(result).toMatchObject(mode === 'plain' ? { ok: true, result: { handoffId: 'moved' } }
            : { ok: false, errorCode: 'target_unavailable' });
    });
});
