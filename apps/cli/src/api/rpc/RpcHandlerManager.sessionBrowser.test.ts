import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { libsodiumEncryptForPublicKey, libsodiumPublicKeyFromSecretKey, encodeBase64 } from '@/api/encryption';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from './RpcHandlerManager';

afterEach(() => vi.restoreAllMocks());

it.each([
    { mode: 'plain', accountMode: 'plain' },
    { mode: 'plain', accountMode: 'e2ee' },
    { mode: 'e2ee', accountMode: 'e2ee' },
    { mode: 'e2ee', accountMode: 'e2ee', contentFailure: 'cancelled' },
    { mode: 'e2ee', accountMode: 'e2ee', contentFailure: 'unavailable' },
] as const)('opens Home-admitted Browser RPC with the exact Session content ($mode Session, $accountMode Account, failure=$contentFailure)', async testCase => {
    const { mode, accountMode } = testCase;
    const contentFailure = 'contentFailure' in testCase ? testCase.contentFailure : null;
    const sessionReadStarted = Promise.withResolvers<void>();
    const seed = new Uint8Array(32).fill(3);
    const publicKey = libsodiumPublicKeyFromSecretKey(seed);
    const sessionKey = new Uint8Array(32).fill(9);
    const sealedKey = libsodiumEncryptForPublicKey(sessionKey, publicKey);
    const bundle = new Uint8Array(sealedKey.length + 1);
    bundle.set(sealedKey, 1);
    const credentials = { token: 'owner-token', encryption: accountMode === 'plain' ? null
        : { type: 'dataKey' as const, machineKey: seed, publicKey } };
    const codec = createMachineContentCodec(mode === 'plain' ? { encryptionMode: 'plain' }
        : { encryptionKey: sessionKey, encryptionVariant: 'dataKey' });
    const content: SocketRpcContent = codec.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
        encryptRaw: async value => codec.encodeRpc(value), decryptRaw: async value => codec.decodeRpc(value),
    } };
    const authorization = { kind: 'session.browser' as const, sessionId: 'exact-session', actorAccountId: 'recipient',
        custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', effectiveAccess: {
            v: 1 as const, level: 'view' as const, sources: [{ kind: 'direct' as const, shareId: 'share' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }),
        } };
    const reads: string[] = [];
    // Only HTTP is substituted: Session selection, envelope opening, RPC binding and local admission remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        reads.push(path);
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: accountMode, version: 1, signingKeyFingerprint: accountMode === 'plain' ? null : 'signing',
            contentKeyFingerprint: accountMode === 'plain' ? null : 'content', updatedAt: 1,
        } };
        if (path === '/v2/sessions/exact-session' && contentFailure === 'unavailable') throw new Error('private resolver failure fixture');
        if (path === '/v2/sessions/exact-session' && contentFailure === 'cancelled') return await new Promise((_resolve, reject) => {
            options?.signal?.addEventListener?.('abort', () => reject(new axios.CanceledError('canceled')));
            sessionReadStarted.resolve();
        });
        if (path === '/v2/sessions/exact-session') return { status: 200, data: { session: {
            id: 'exact-session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            encryptionMode: mode, metadata: codec.encodeStored({}), metadataVersion: 1, share: null,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: mode === 'plain' ? null : encodeBase64(bundle),
        } } };
        throw new Error(`Unexpected HTTP read: ${path}`);
    });
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'e2ee',
        encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey', logger() {},
        authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
            machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
            verifyMachineAdmission: async () => { throw new Error('Session Browser must not acquire a Machine grant'); },
        }, source),
        resolveSessionBrowserContent: async ({ authorization: access, signal }) => {
            const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials,
                exact: true, idOrPrefix: access.sessionId, signal,
                serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' } });
            return !transport.ok ? null : createMachineContentCodec(transport.mode === 'plain' ? { encryptionMode: 'plain' } : transport.ctx);
        },
    });
    manager.registerHandler(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT, (input, context) => ({ input, mode: context?.sessionBrowserContent?.mode }));
    const method = `machine:${RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT}`;
    const callId = '71'.repeat(16);
    const input = { sessionId: 'exact-session', sourceId: 'browser-source', streamFamily: 'browser.streamed', protocolVersion: 1, machineId: 'machine' };
    // Home routes this Session-prefixed envelope to the physical Machine handler.
    const params = await socketRpcCodec.encodeParams(content, input, { method: `${authorization.sessionId}:${RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT}`, callId });
    const request = { method, params, authorization, callerAuthority: 'present_user' as const };
    expect(await manager.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(reads).toEqual([]);
    const pendingResponse = manager.handleRequest(request, undefined, 'authenticated_home_socket');
    if (contentFailure) {
        if (contentFailure === 'cancelled') {
            await sessionReadStarted.promise;
            manager.cancelTransportRequests();
        }
        // An unread encrypted envelope permits only a typed refusal, never a rejected receive callback.
        await expect(pendingResponse).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        expect(JSON.stringify(await pendingResponse)).not.toContain('private resolver failure fixture');
        return;
    }
    const response = await pendingResponse;
    expect(await socketRpcCodec.decodeResult(content, { ok: true, result: response }, callId)).toEqual({ input, mode });
    expect(reads.sort()).toEqual(['/v1/account/encryption/currentness', '/v2/sessions/exact-session']);
});
