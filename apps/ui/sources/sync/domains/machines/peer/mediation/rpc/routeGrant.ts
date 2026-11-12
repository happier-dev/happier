import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { SignedDirectRouteGrantV2Schema, type SignedDirectRouteGrantV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { createEphemeralPeerRouteProofHandleV2, type PeerRouteEphemeralProofV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { requestPeerMediationServerJsonForCredential } from '../peerMediationServerRequest';

const MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS = 30_000;
type TargetServer = Readonly<{ serverId: string; serverUrl: string }>;
type OperationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reasonCode: string }>;
type Admission = Readonly<{ grant: SignedDirectRouteGrantV2; proof: PeerRouteEphemeralProofV2 }>;
type CachedAdmission = { expiresAt: number | null; pending: Promise<OperationResult<Admission>> };
const admissions = new Map<string, CachedAdmission>();

/** Socket withdrawal ends this requester's signed admission lifetime. */
export function clearMachineRpcDirectRouteGrants(): void {
    admissions.clear();
}

async function requestMachineRpcRouteGrantV2(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    machineId: string;
    method: string;
    endpointFingerprint: string;
    ephemeralPublicKeyBase64Url: string;
    timeoutMs?: number;
}>): Promise<OperationResult<SignedDirectRouteGrantV2>> {
    try {
        const response = await requestPeerMediationServerJsonForCredential({
            serverId: input.server.serverId,
            token: input.credentials.token,
            path: '/v1/machines/peer/mediation/route-grants',
            timeoutMs: input.timeoutMs,
            init: {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    v: 2,
                    kind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: input.ephemeralPublicKeyBase64Url,
                    machineId: input.machineId,
                    flowKind: 'machine_rpc',
                    routeKind: 'loopback_direct',
                    endpointFingerprint: input.endpointFingerprint,
                    ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.loopbackMachineRpcDefault,
                    scope: {
                        kind: 'machine_rpc',
                        rpcScopeId: `${input.machineId}:${input.method}`,
                        allowedMethods: [input.method],
                        maxIdleMs: MACHINE_RPC_DIRECT_GRANT_MAX_IDLE_MS,
                    },
                }),
            },
        });
        if (!response.ok) return { ok: false, reasonCode: 'grant_missing' };
        const body = response.body as { ok?: unknown; reasonCode?: unknown; grant?: unknown } | null;
        if (body?.ok !== true) {
            return {
                ok: false,
                reasonCode: typeof body?.reasonCode === 'string' ? body.reasonCode : 'grant_missing',
            };
        }
        const parsed = SignedDirectRouteGrantV2Schema.safeParse(body.grant);
        return parsed.success
            ? { ok: true, value: parsed.data }
            : { ok: false, reasonCode: 'grant_invalid' };
    } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        return { ok: false, reasonCode: 'grant_missing' };
    }
}


export function resolveMachineRpcDirectRouteGrant(input: Readonly<{
    server: TargetServer;
    credentials: AuthCredentials;
    accountId: string;
    machineId: string;
    method: string;
    endpointUrl: string;
    endpointFingerprint: string;
    timeoutMs?: number;
}>): Promise<OperationResult<Admission>> {
    // The immutable credential fingerprint separates present-user and automation
    // bearer authority. The issuer signs that authority into each admission.
    const key = JSON.stringify([input.server.serverId, input.server.serverUrl, input.accountId,
        resolveAuthCredentialsScopeKey(input.credentials), input.machineId, input.method,
        input.endpointUrl, input.endpointFingerprint]);
    const cached = admissions.get(key);
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) return cached.pending;
    const entry: CachedAdmission = { expiresAt: null, pending: Promise.resolve({ ok: false, reasonCode: 'grant_missing' }) };
    entry.pending = (async (): Promise<OperationResult<Admission>> => {
        const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: getRandomBytes });
        try {
            const result = await requestMachineRpcRouteGrantV2({ ...input, ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url });
            if (!result.ok) return result;
            entry.expiresAt = result.value.payload.exp;
            return { ok: true, value: { grant: result.value, proof: proofHandle.sign(result.value) } };
        } catch (error) {
            if (error instanceof CredentialRequestRedirectError) throw error;
            return { ok: false, reasonCode: 'grant_invalid' };
        } finally {
            proofHandle.dispose();
        }
    })();
    admissions.set(key, entry);
    void entry.pending.then(result => {
        if ((!result.ok || entry.expiresAt === null || entry.expiresAt <= Date.now()) && admissions.get(key) === entry) admissions.delete(key);
    }, () => { if (admissions.get(key) === entry) admissions.delete(key); });
    return entry.pending;
}
