import * as React from 'react';

import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { authQRStart, type HomeQrEnrollmentTarget, type QRAuthKeyPair } from '@/auth/flows/qrStart';
import { authQRWait } from '@/auth/flows/qrWait';
import { buildRenderableHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { pairingRequest } from '@/sync/api/account/apiPairingAuth';
import { probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    adoptHomeProfileWithCredentials,
    isHomeProfileAdoptionPartialCommitFailure,
    type HomeProfileAdoptionPartialCommitFailure,
} from '@/sync/domains/server/adoptHomeProfile';
import { buildHomeConnectionDescriptorForProfile, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { computeHomeQrBindingProofV2, createHomeQrReverseInviteV2, deriveHomeQrBindingKeyV2, deriveHomeQrRendezvousSecretV2, type HomeQrInviteV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { enrollmentPollingBackoffMs } from '@/auth/enrollment/enrollmentPollingBackoff';
import { admitDirectHomeQrV2 } from '@happier-dev/cli-common/homeEnrollment';

export type ReversePairingPresentation =
    | Readonly<{ phase: 'generating' }>
    | Readonly<{ phase: 'ready'; invite: HomeQrInviteV2; link: string; qrAvailable: boolean; descriptor: HomeConnectionDescriptorV1 }>
    | Readonly<{ phase: 'adding'; descriptor: HomeConnectionDescriptorV1; expiresAtMs: number }>
    | Readonly<{ phase: 'succeeded'; descriptor: HomeConnectionDescriptorV1; profileId: string }>
    | Readonly<{ phase: 'expired' | 'invalid' | 'update_required'; descriptor?: HomeConnectionDescriptorV1 }>
    | Readonly<{
        phase: 'retryable_error';
        descriptor?: HomeConnectionDescriptorV1;
        partialCommit: HomeProfileAdoptionPartialCommitFailure | null;
    }>;

type ReverseAttempt = {
    generation: number;
    controller: AbortController;
    target: HomeQrEnrollmentTarget | null;
    authorityClaimed: boolean;
    presentationAttached: boolean;
};

function isTransientStatus(status: number): boolean {
    return status === 0 || status === 408 || status === 429 || status >= 500;
}

async function waitForRetry(expiresAtMs: number, failures: number, signal: AbortSignal): Promise<boolean> {
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0 || signal.aborted) return false;
    const delayMs = Math.min(enrollmentPollingBackoffMs(failures), remainingMs);
    return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(!signal.aborted && Date.now() < expiresAtMs);
        }, delayMs);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Owns one credentialless, known-target requester-displayed QR lifecycle in memory. */
export function useReversePairingSession(params: Readonly<{ enabled: boolean; targetProfileId: string | null }>): Readonly<{
    presentation: ReversePairingPresentation;
    canCancel: boolean;
    start: () => Promise<void>;
    cancel: () => Promise<void>;
}> {
    const [presentation, setPresentation] = React.useState<ReversePairingPresentation>({ phase: 'generating' });
    const attemptRef = React.useRef<ReverseAttempt | null>(null);
    const generationRef = React.useRef(0);
    const startedRef = React.useRef(false);

    const isCurrent = React.useCallback((attempt: ReverseAttempt) => (
        attemptRef.current === attempt
        && generationRef.current === attempt.generation
        && !attempt.controller.signal.aborted
    ), []);

    const retire = React.useCallback(async (attempt: ReverseAttempt) => {
        if (attemptRef.current === attempt) attemptRef.current = null;
        await attempt.target?.close().catch(() => {});
    }, []);

    const publish = React.useCallback((attempt: ReverseAttempt, next: ReversePairingPresentation) => {
        if (attempt.presentationAttached && isCurrent(attempt)) setPresentation(next);
    }, [isCurrent]);

    const cancel = React.useCallback(async () => {
        const attempt = attemptRef.current;
        if (!attempt || attempt.authorityClaimed) return;
        generationRef.current += 1;
        attemptRef.current = null;
        attempt.controller.abort();
        const target = attempt.target;
        attempt.target = null;
        await target?.close().catch(() => {});
        setPresentation((current) => ({
            phase: 'retryable_error',
            ...('descriptor' in current && current.descriptor ? { descriptor: current.descriptor } : {}),
            partialCommit: null,
        }));
    }, []);

    const start = React.useCallback(async () => {
        if (!params.enabled || attemptRef.current) return;
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        const attempt: ReverseAttempt = {
            generation,
            controller: new AbortController(),
            target: null,
            authorityClaimed: false,
            presentationAttached: true,
        };
        attemptRef.current = attempt;
        setPresentation({ phase: 'generating' });

        try {
            // Resolve only the caller-selected stored Home. Ambient focus and fallback profiles
            // are deliberately not enrollment authority.
            const profile = params.targetProfileId ? getServerProfileById(params.targetProfileId) : null;
            const descriptor = profile ? buildHomeConnectionDescriptorForProfile(profile) : null;
            if (!descriptor || profile?.serverIdentityId !== descriptor.homeServerIdentityId) {
                if (!isCurrent(attempt)) return;
                publish(attempt, { phase: 'invalid' });
                return;
            }
            const transportResolution = await resolveHomeEnrollmentTransport(descriptor);
            if (!isCurrent(attempt)) {
                if (transportResolution.ok) await transportResolution.transport.close().catch(() => {});
                return;
            }
            if (!transportResolution.ok) {
                publish(attempt, { phase: 'retryable_error', descriptor, partialCommit: null });
                return;
            }
            const target: HomeQrEnrollmentTarget = { ...transportResolution.transport, serverId: profile.id };
            attempt.target = target;
            const featureSnapshot = await probeServerFeaturesAtUrl({
                endpointUrl: target.endpointUrl,
                ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
                ...(target.homeCarrier ? { homeCarrier: target.homeCarrier } : {}),
                serverId: profile.id,
                force: true,
                signal: attempt.controller.signal,
            });
            if (!isCurrent(attempt)) return;
            if (featureSnapshot.status !== 'ready' || featureSnapshot.serverIdentityId !== descriptor.homeServerIdentityId) {
                publish(attempt, { phase: 'invalid', descriptor });
                return;
            }
            if (admitDirectHomeQrV2(featureSnapshot.features).kind !== 'admitted') {
                publish(attempt, { phase: 'update_required', descriptor });
                return;
            }

            const material = createHomeQrReverseInviteV2({ home: descriptor, nowMs: Date.now() });
            const keypair: QRAuthKeyPair = {
                publicKey: material.requesterPublicKey,
                secretKey: material.requesterSecretKey,
            };
            const started = await authQRStart(keypair, target, { signal: attempt.controller.signal });
            if (!isCurrent(attempt)) return;
            if (!started.ok) {
                publish(attempt, {
                    phase: started.reason === 'transient' ? 'retryable_error' : 'invalid',
                    descriptor,
                    ...(started.reason === 'transient' ? { partialCommit: null } : {}),
                } as ReversePairingPresentation);
                return;
            }
            const renderable = buildRenderableHomeQrInviteDeepLink({ invite: material.invite });
            if (!renderable.ok && renderable.reason === 'invalid_invite') {
                publish(attempt, { phase: 'invalid', descriptor });
                return;
            }
            publish(attempt, {
                phase: 'ready',
                invite: material.invite,
                link: renderable.link,
                qrAvailable: renderable.ok,
                descriptor,
            });

            const bindingProof = computeHomeQrBindingProofV2({
                direction: material.invite.direction,
                qrSecret: material.qrSecret,
                pairId: material.invite.pairId,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                requesterPublicKey: material.requesterPublicKey,
                expiresAtMs: material.invite.expiresAtMs,
            });
            const pairingParams = {
                pairId: material.invite.pairId,
                secret: encodeBase64(deriveHomeQrRendezvousSecretV2(material.qrSecret), 'base64url'),
                publicKey: encodeBase64(material.requesterPublicKey),
                homeServerIdentityId: descriptor.homeServerIdentityId,
                expiresAtMs: material.invite.expiresAtMs,
                bindingProof,
            };
            let failures = 0;
            while (isCurrent(attempt)) {
                const request = await pairingRequest(pairingParams, target, { signal: attempt.controller.signal });
                if (!isCurrent(attempt)) return;
                if (request.ok) break;
                // In the requester-displayed direction, the authenticated scanner owns
                // row creation. A 404 is therefore the expected pre-row wait until that
                // trusted device has scanned this still-visible invite. Once the tuple is
                // installed, authQRWait owns disappearance/expiry as a terminal outcome.
                if (request.reason !== 'not_found' && !isTransientStatus(request.status)) {
                    publish(attempt, { phase: 'invalid', descriptor });
                    return;
                }
                failures += 1;
                if (!await waitForRetry(material.invite.expiresAtMs, failures, attempt.controller.signal)) {
                    publish(attempt, { phase: 'expired', descriptor });
                    return;
                }
            }
            if (!isCurrent(attempt)) return;
            // Once the target Home has accepted this exact requester tuple, its
            // completion decision may race any presentation teardown. Keep the
            // credential-bound continuation alive so an immutable response is
            // always adopted locally; only cancellation before this commit point
            // aborts the attempt.
            attempt.authorityClaimed = true;
            publish(attempt, {
                phase: 'ready',
                invite: material.invite,
                link: renderable.link,
                qrAvailable: renderable.ok,
                descriptor,
            });
            // Requester registration is not trusted-device completion. Keep the exact
            // invite visible while the authenticated scanner verifies and commits the response.
            const result = await authQRWait(keypair, target, {
                signal: attempt.controller.signal,
                expiresAtMs: material.invite.expiresAtMs,
                v2Context: {
                    direction: material.invite.direction,
                    pairId: material.invite.pairId,
                    homeServerIdentityId: descriptor.homeServerIdentityId,
                    bindingSecret: deriveHomeQrBindingKeyV2(material.qrSecret),
                    bindingProof,
                    issuedAtMs: material.invite.issuedAtMs,
                    expiresAtMs: material.invite.expiresAtMs,
                },
            });
            if (!isCurrent(attempt)) return;
            if (!result.ok) {
                publish(attempt, {
                    phase: result.reason === 'expired' ? 'expired' : result.reason === 'cancelled' ? 'retryable_error' : 'invalid',
                    descriptor,
                    ...(result.reason === 'cancelled' ? { partialCommit: null } : {}),
                } as ReversePairingPresentation);
                return;
            }
            // The authenticated Home has now returned a sealed response bound to this
            // requester's immutable key. Credential adoption is the first non-cancellable
            // local commit boundary.
            publish(attempt, { phase: 'adding', descriptor, expiresAtMs: material.invite.expiresAtMs });
            let adoptedProfileId: string;
            try {
                const adoptedProfile = await adoptHomeProfileWithCredentials({
                    descriptor,
                    source: 'qr',
                    preserveUserLabel: true,
                    credentials: result.credentials,
                    shouldCancel: () => !isCurrent(attempt!),
                });
                adoptedProfileId = adoptedProfile.id;
            } catch (error) {
                if (!isCurrent(attempt)) return;
                publish(attempt, {
                    phase: 'retryable_error',
                    descriptor,
                    partialCommit: isHomeProfileAdoptionPartialCommitFailure(error) ? error : null,
                });
                return;
            }
            if (isCurrent(attempt)) {
                publish(attempt, { phase: 'succeeded', descriptor, profileId: adoptedProfileId });
            }
        } catch {
            if (!isCurrent(attempt)) return;
            const descriptor = attempt.target?.descriptor;
            publish(attempt, {
                phase: 'retryable_error',
                ...(descriptor ? { descriptor } : {}),
                partialCommit: null,
            });
        } finally {
            await retire(attempt);
        }
    }, [isCurrent, params.enabled, params.targetProfileId, publish, retire]);

    React.useEffect(() => {
        if (!params.enabled || startedRef.current) return;
        startedRef.current = true;
        void start();
    }, [params.enabled, start]);

    React.useEffect(() => () => {
        const attempt = attemptRef.current;
        if (!attempt) return;
        attempt.presentationAttached = false;
        if (attempt.authorityClaimed) return;
        generationRef.current += 1;
        attemptRef.current = null;
        attempt.controller.abort();
        void attempt.target?.close().catch(() => {});
    }, []);

    return {
        presentation,
        canCancel: attemptRef.current !== null
            && !attemptRef.current.authorityClaimed
            && presentation.phase === 'ready',
        start,
        cancel,
    };
}
