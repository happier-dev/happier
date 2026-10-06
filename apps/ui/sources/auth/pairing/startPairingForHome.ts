import { startDirectHomeQrLifecycle, type DirectHomeQrStartResult } from '@happier-dev/cli-common/homeEnrollment';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { buildRenderableHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { createPairingSecret } from '@/auth/pairing/pairingSecret';
import { createTrustedHomeQrCompletionAdapters } from '@/auth/pairing/trustedHomeQrCompletionAdapters';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { pairingStart, type PairingCallTarget, type PairingStatus } from '@/sync/api/account/apiPairingAuth';
import { getServerFeaturesSnapshot, observeAuthenticatedServerFeaturesFresh } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildHomeConnectionDescriptorForProfile, getServerProfileById, reconcileServerProfileHomeConnectionDescriptor } from '@/sync/domains/server/serverProfiles';

export type HomePairingFailureCause = 'home_unreachable' | 'home_identity_unverified' | 'signed_out' | 'invite_too_large' | 'home_refused' | 'unexpected';
export type StartedHomePairing = Extract<DirectHomeQrStartResult, { kind: 'started' }> & Readonly<{ target: PairingCallTarget }>;
export type StartPairingForHomeResult = StartedHomePairing
    | Readonly<{ kind: 'failed'; cause: HomePairingFailureCause; status: number; reason?: 'invalid_invite' }>
    | Readonly<{ kind: 'update_required' | 'cancelled' }>;

/** The same verified Home target and enrollment lifecycle for panels and Actions. */
export async function startPairingForHome(params: Readonly<{
    targetProfileId?: string | null;
    signal: AbortSignal;
    isCurrent?: () => boolean;
    onStatus?: (status: PairingStatus) => void;
    onCompleting?: (label: string | null) => void;
    onRetrying?: () => void;
}>): Promise<StartPairingForHomeResult> {
    const isCurrent = () => !params.signal.aborted && (params.isCurrent?.() ?? true);
    const failed = (cause: HomePairingFailureCause, status = 412): StartPairingForHomeResult => ({ kind: 'failed', cause, status });
    let target: PairingCallTarget | null = null;
    let lifecycleOwnsTarget = false;
    let observationTransport: Awaited<ReturnType<typeof resolveHomeEnrollmentTransport>> | null = null;
    try {
        const active = getActiveServerSnapshot();
        const serverId = params.targetProfileId?.trim() || active.serverId;
        const runtimeTransport = serverId === active.serverId ? { runtimeOrigin: active.runtimeOrigin, runtimeCarrier: active.carrier } : {};
        const snapshot = await getServerFeaturesSnapshot({ serverId, signal: params.signal });
        if (!isCurrent()) return { kind: 'cancelled' };
        if (snapshot.status === 'unsupported') return { kind: 'update_required' };
        if (snapshot.status !== 'ready') return failed('home_unreachable');
        const observedIdentity = String(snapshot.serverIdentityId ?? '').trim();
        if (!observedIdentity) return failed('home_identity_unverified');
        const profile = getServerProfileById(serverId);
        const retainedDescriptor = profile ? buildHomeConnectionDescriptorForProfile(profile) : null;
        if (!retainedDescriptor || !observedIdentity || retainedDescriptor.homeServerIdentityId !== observedIdentity) return failed('home_identity_unverified');
        const credentials = await TokenStorage.getCredentialsForServerUrl(retainedDescriptor.canonicalServerUrl, { serverId: retainedDescriptor.homeServerIdentityId });
        if (!credentials) return failed('signed_out');
        observationTransport = await resolveHomeEnrollmentTransport(retainedDescriptor, { ...runtimeTransport, verification: { kind: 'authenticated', token: credentials.token } });
        if (!observationTransport.ok) return failed('home_unreachable');
        const authenticatedSnapshot = await observeAuthenticatedServerFeaturesFresh({ request: observationTransport.transport.createRequest({ serverId: retainedDescriptor.homeServerIdentityId, credentials }) });
        if (!isCurrent()) return { kind: 'cancelled' };
        if (authenticatedSnapshot.status !== 'ready') return failed('home_unreachable');
        const authenticatedIdentity = String(authenticatedSnapshot.serverIdentityId ?? '').trim();
        const descriptor = authenticatedSnapshot.features.homeConnectionDescriptor;
        if (!descriptor || authenticatedIdentity !== retainedDescriptor.homeServerIdentityId || descriptor.homeServerIdentityId !== retainedDescriptor.homeServerIdentityId) return failed('home_identity_unverified');
        const reconciliation = await reconcileServerProfileHomeConnectionDescriptor({ serverUrl: retainedDescriptor.canonicalServerUrl, observedServerIdentityId: authenticatedIdentity, descriptor, observation: 'exact' });
        if (reconciliation.kind !== 'applied' && reconciliation.kind !== 'unchanged') return failed('home_identity_unverified');
        await observationTransport.transport.close();
        observationTransport = null;
        const transport = await resolveHomeEnrollmentTransport(descriptor, { ...runtimeTransport, verification: { kind: 'authenticated', token: credentials.token } });
        if (!transport.ok) return failed('home_unreachable');
        target = { ...transport.transport, serverId };
        if (!isCurrent()) return { kind: 'cancelled' };
        const immutableTarget = target;
        const started = await startDirectHomeQrLifecycle({ features: authenticatedSnapshot.features, descriptor, signal: params.signal, adapters: {
            randomBytes: async () => decodeBase64((await createPairingSecret()).secret, 'base64url'),
            start: async ({ signal, ...body }) => {
                const result = await pairingStart(body, immutableTarget, { signal });
                return result.ok ? { ok: true, pairId: result.data.pairId, expiresAt: result.data.expiresAt } : { ok: false, status: result.status };
            },
            buildRenderableInvite: (invite) => buildRenderableHomeQrInviteDeepLink({ invite }),
            ...createTrustedHomeQrCompletionAdapters({ target: immutableTarget, onStatus: params.onStatus, onCompleting: params.onCompleting, onRetrying: params.onRetrying }),
        } });
        lifecycleOwnsTarget = true;
        if (!isCurrent()) { if (started.kind === 'started') await started.cancel(); return { kind: 'cancelled' }; }
        if (started.kind === 'failed') return { kind: 'failed', cause: started.reason === 'invalid_invite' ? 'invite_too_large' : 'home_refused', status: started.status, ...(started.reason === 'invalid_invite' ? { reason: 'invalid_invite' as const } : {}) };
        return started.kind === 'started' ? { ...started, target: immutableTarget } : started;
    } catch {
        return isCurrent() ? failed('unexpected', 500) : { kind: 'cancelled' };
    } finally {
        if (observationTransport?.ok) await observationTransport.transport.close().catch(() => {});
        if (target && !lifecycleOwnsTarget) await target.close().catch(() => {});
    }
}
