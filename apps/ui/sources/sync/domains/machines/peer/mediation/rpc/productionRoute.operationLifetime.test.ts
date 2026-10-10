import { afterEach, expect, it, vi } from 'vitest';
import { PEER_MEDIATION_RECEIPTS, type PeerMachineRpcDirectRequestV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { postProductionMachineRpcDirect } from './productionRoute';

// The real direct HTTP adapter receives a typed wire request; only fetch and
// the clock are replaced. Grant admission remains the daemon's boundary.
const request: PeerMachineRpcDirectRequestV2 = {
    v: 2, requestId: 'request-a', method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, params: {},
    grant: {
        payload: {
            v: 2, grantId: 'grant-a', accountId: 'account-a', machineId: 'machine-a',
            flowKind: 'machine_rpc', routeKind: 'loopback_direct',
            scope: { kind: 'machine_rpc', rpcScopeId: 'scope-a', allowedMethods: [RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ], maxCalls: 1, maxIdleMs: 30_000 },
            iat: 1_000, exp: 301_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint-a',
            proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: Buffer.alloc(32, 1).toString('base64url'),
        },
        signature: { keyId: 'key-a', alg: 'Ed25519', valueBase64Url: Buffer.alloc(64, 2).toString('base64url') },
    },
    proof: {
        v: 2, kind: 'ephemeral_ed25519', signedGrantDigestBase64Url: Buffer.alloc(32, 1).toString('base64url'),
        nonceBase64Url: 'nonce-a', signatureBase64Url: Buffer.alloc(64, 2).toString('base64url'),
    },
    routeKind: 'loopback_direct', flowKind: 'machine_rpc', endpointFingerprint: 'endpoint-a',
};
const response = { v: 2, ok: true, requestId: request.requestId, method: request.method,
    receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded, routeKind: 'loopback_direct', result: { ready: true } } as const;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps direct plugin work alive beyond its former HTTP cutoff and preserves caller cancellation', async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    let issuedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        issuedSignal = init.signal ?? undefined;
        return await new Promise<Response>((resolve, reject) => {
            answer = resolve;
            issuedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
    }));
    const controller = new AbortController();
    const pending = postProductionMachineRpcDirect({
        url: 'http://127.0.0.1:1234/rpc', request, operationTimeoutMs: null, signal: controller.signal,
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(issuedSignal?.aborted).toBe(false);
    expect(settled).toBe(false);
    answer(Response.json(response));
    await expect(pending).resolves.toEqual(response);

    const cancelled = postProductionMachineRpcDirect({
        url: 'http://127.0.0.1:1234/rpc', request, operationTimeoutMs: null, signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false, reasonCode: 'topology_unavailable' });
    expect(issuedSignal?.aborted).toBe(true);
});
