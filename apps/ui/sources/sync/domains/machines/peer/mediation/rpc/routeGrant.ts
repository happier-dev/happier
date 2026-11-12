import type { SignedDirectRouteGrantV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import type { PeerRouteEphemeralProofV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';

type OperationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reasonCode: string }>;
type Admission = Readonly<{ grant: SignedDirectRouteGrantV2; proof: PeerRouteEphemeralProofV2 }>;
type CachedAdmission = { expiresAt: number | null; pending: Promise<OperationResult<Admission>> };
const admissions = new Map<string, CachedAdmission>();

/** Socket withdrawal ends this requester's signed admission lifetime. */
export function clearMachineRpcDirectRouteGrants(): void {
    admissions.clear();
}

/** Keep socket invalidation independent of the requester/authentication import graph. */
export function resolveMachineRpcDirectRouteGrant(input: Readonly<{
    key: string;
    admit: () => Promise<OperationResult<Admission>>;
}>): Promise<OperationResult<Admission>> {
    const cached = admissions.get(input.key);
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) return cached.pending;
    const entry: CachedAdmission = { expiresAt: null, pending: Promise.resolve({ ok: false, reasonCode: 'grant_missing' }) };
    entry.pending = (async () => {
        const result = await input.admit();
        if (result.ok) entry.expiresAt = result.value.grant.payload.exp;
        return result;
    })();
    admissions.set(input.key, entry);
    void entry.pending.then(result => {
        if ((!result.ok || entry.expiresAt === null || entry.expiresAt <= Date.now()) && admissions.get(input.key) === entry) admissions.delete(input.key);
    }, () => { if (admissions.get(input.key) === entry) admissions.delete(input.key); });
    return entry.pending;
}
