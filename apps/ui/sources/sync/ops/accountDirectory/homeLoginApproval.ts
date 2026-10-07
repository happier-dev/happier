import {
    AccountDirectoryRequestError,
    AccountDirectoryResponseError,
    redeemHomeLoginAssertion,
    type AccountDirectoryHomeEntryV1,
    type HomeLoginAssertionV1,
} from '@/sync/api/accountDirectory/accountDirectoryClient';
import {
    ACCOUNT_DIRECTORY_ERROR_CODES_V1,
    ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES,
    ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES,
    HomeLoginCredentialPayloadV1Schema,
} from '@happier-dev/protocol/auth/accountDirectory';
import {
    continueAccountServiceHomeEnrollment,
    type AccountServiceHomeEnrollmentResult,
} from '@happier-dev/cli-common/accountService';
import { decodeBase64 } from '@/encryption/base64';
import { decryptBox } from '@/encryption/libsodium';
import {
    resolveHomeEnrollmentTransport,
    type HomeEnrollmentTransportFailureReason,
} from '@/auth/enrollment/homeEnrollmentTransport';
import {
    adoptHomeProfileWithCredentials,
    isHomeProfileAdoptionPartialCommitFailure,
    type HomeProfileAdoptionPartialCommitFailure,
} from '@/sync/domains/server/adoptHomeProfile';
import {
    observeAuthenticatedServerFeaturesFresh,
    probeServerFeaturesAtUrl,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    reconcileServerProfileHomeConnectionDescriptor,
} from '@/sync/domains/server/serverProfiles';
import { adoptDirectoryHome } from './adoptDirectoryHome';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { parseToken } from '@/utils/auth/parseToken';

/**
 * Home-authoritative existing-device approval continuation. All requests target the exact
 * Home endpoint; approver routes authenticate with that Home's own full stored credential
 * and never with Account Service, directory, PAT, or assertion-only credentials.
 */

/** Terminal outcomes of an approval continuation; no credential material is exposed. */
export type HomeLoginContinuationResult =
    | Readonly<{ kind: 'enrolled'; homeServerIdentityId: string }>
    | Readonly<{
        kind: 'approval_required';
        homeServerIdentityId: string;
        approvalId: string;
        expiresAtMs: number;
        resume: () => Promise<HomeLoginContinuationResult>;
        cancel: () => Promise<HomeLoginContinuationResult>;
    }>
    | Readonly<{
        kind: 'transport_unavailable';
        reason: HomeEnrollmentTransportFailureReason | 'home_observation_unavailable' | 'request_failed';
        resume?: () => Promise<HomeLoginContinuationResult>;
        cancel?: () => Promise<HomeLoginContinuationResult>;
    }>
    | Readonly<{ kind: 'rejected' }>
    | Readonly<{ kind: 'expired' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{
        kind: 'partial_commit';
        homeServerIdentityId: string;
        canonicalServerUrl: string;
        error: HomeProfileAdoptionPartialCommitFailure;
    }>
    | Readonly<{ kind: 'failed'; reason?: 'account_mismatch'; error?: unknown }>;

/**
 * Decrypts and strictly parses the exact protocol-owned `{ token }` plaintext.
 * Credential wrappers, descriptor envelopes, and every extra field fail closed.
 */
function decodeHomeCredentialPayload(
    value: unknown,
    clientSecretKey: Uint8Array,
) {
    if (typeof value !== 'string' || value.length === 0) return null;
    let sealedBytes: Uint8Array;
    try {
        sealedBytes = decodeBase64(value, 'base64url');
    } catch {
        return null;
    }
    if (sealedBytes.byteLength > ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES) return null;
    const opened = decryptBox(sealedBytes, clientSecretKey);
    if (
        !opened
        || opened.length === 0
        || opened.length > ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES
    ) return null;
    try {
        const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened));
        const parsed = HomeLoginCredentialPayloadV1Schema.safeParse(payload);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function terminalRedemptionError(error: unknown): HomeLoginContinuationResult | null {
    if (error instanceof AccountDirectoryResponseError) return { kind: 'failed', error };
    if (error instanceof AccountDirectoryRequestError && !error.transient) {
        if (
            error.code === ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionExpired
            || error.code === ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalExpired
        ) return { kind: 'expired' };
        if (error.code === ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalRejected) return { kind: 'rejected' };
        return { kind: 'failed', error };
    }
    return null;
}

class HomeEnrollmentBoundaryError extends Error {
    constructor(readonly result: HomeLoginContinuationResult) {
        super('home_enrollment_boundary_error');
    }
}

type HomeLoginApprovalContinuation = Extract<
    HomeLoginContinuationResult,
    { kind: 'approval_required' }
>;

type HomeLoginCancellationState = {
    cancelled: boolean;
    readonly externalShouldCancel?: () => boolean;
    readonly credentialCustodyIsCurrent?: () => boolean;
    retained: boolean;
};

function retainCancellationState(state: HomeLoginCancellationState): HomeLoginCancellationState {
    state.retained = true;
    return state;
}

function createSingleFlightResume(
    run: () => Promise<HomeLoginContinuationResult>,
): () => Promise<HomeLoginContinuationResult> {
    let result: Promise<HomeLoginContinuationResult> | null = null;
    return () => {
        result ??= run();
        return result;
    };
}

function isCancelled(state: HomeLoginCancellationState): boolean {
    return state.cancelled
        || state.credentialCustodyIsCurrent?.() === false
        || (!state.retained && state.externalShouldCancel?.() === true);
}

function createApprovalContinuation(
    input: Readonly<{
        home: AccountDirectoryHomeEntryV1;
        clientSecretKey: Uint8Array;
        assertion: HomeLoginAssertionV1;
        cancellationState: HomeLoginCancellationState;
    }>,
    approvalId: string,
    expiresAtMs: number,
): HomeLoginApprovalContinuation {
    // The initiating screen's cancellation signal owns only its in-flight
    // redemption attempt. Once the Home has durably returned approval_required,
    // the service-scoped continuation must survive normal navigation/unmount;
    // explicit service change/disconnect still invokes this continuation's
    // cancel method and flips the detached state below.
    const cancellationState = retainCancellationState(input.cancellationState);
    const continuationInput = { ...input, cancellationState };
    return {
        kind: 'approval_required',
        homeServerIdentityId: input.home.connectionDescriptor.homeServerIdentityId,
        approvalId,
        expiresAtMs,
        resume: createSingleFlightResume(async () => await continueHomeLoginEnrollment({
            ...continuationInput,
            approvalId,
            approvalExpiresAtMs: expiresAtMs,
        })),
        cancel: async () => {
            cancellationState.cancelled = true;
            return { kind: 'cancelled' };
        },
    };
}

function createExplicitResumeContinuation(
    input: Parameters<typeof createApprovalContinuation>[0],
    reason: HomeEnrollmentTransportFailureReason | 'home_observation_unavailable' | 'request_failed',
    approval?: Readonly<{ approvalId: string; expiresAtMs: number }>,
): Extract<HomeLoginContinuationResult, { kind: 'transport_unavailable' }> {
    // Retryable initial failures are retained by the Account Service owner, so
    // normal initiating-screen teardown must not destroy the only assertion/key
    // tuple. Explicit continuation cancellation remains authoritative.
    const cancellationState = retainCancellationState(input.cancellationState);
    const continuationInput = { ...input, cancellationState };
    return {
        kind: 'transport_unavailable',
        reason,
        resume: createSingleFlightResume(async () => await continueHomeLoginEnrollment({
            ...continuationInput,
            ...(approval ? {
                approvalId: approval.approvalId,
                approvalExpiresAtMs: approval.expiresAtMs,
            } : {}),
        })),
        cancel: async () => {
            cancellationState.cancelled = true;
            return { kind: 'cancelled' };
        },
    };
}

/**
 * Attempt assertion enrollment once. Approval retains only assertion-bound state and reacquires
 * transport for each explicit resume. Scheduling and polling remain Lane 05 UI concerns rather
 * than an Account Directory background loop.
 */
export async function continueHomeLoginEnrollment(input: Readonly<{
    home: AccountDirectoryHomeEntryV1;
    clientSecretKey: Uint8Array;
    assertion: HomeLoginAssertionV1;
    approvalId?: string;
    approvalExpiresAtMs?: number;
    shouldCancel?: () => boolean;
    credentialCustodyIsCurrent?: () => boolean;
    cancellationState?: HomeLoginCancellationState;
}>): Promise<HomeLoginContinuationResult> {
    const cancellationState = input.cancellationState ?? {
        cancelled: false,
        retained: false,
        ...(input.shouldCancel ? { externalShouldCancel: input.shouldCancel } : {}),
        ...(input.credentialCustodyIsCurrent ? { credentialCustodyIsCurrent: input.credentialCustodyIsCurrent } : {}),
    };
    const continuationInput = { ...input, cancellationState };
    if (isCancelled(cancellationState)) return { kind: 'cancelled' };
    if (input.approvalExpiresAtMs !== undefined && Date.now() >= input.approvalExpiresAtMs) {
        return { kind: 'expired' };
    }
    const descriptor = input.home.connectionDescriptor;
    const targetIdentity = descriptor.homeServerIdentityId;
    let authenticatedDescriptor: typeof descriptor | null = null;
    const result: AccountServiceHomeEnrollmentResult<Uint8Array, void> =
        await continueAccountServiceHomeEnrollment({
            home: input.home,
            assertion: input.assertion,
            requesterSecretKey: input.clientSecretKey,
            ...(input.approvalId ? { approvalId: input.approvalId } : {}),
            nowMs: Date.now(),
            shouldCancel: () => isCancelled(cancellationState),
            adapters: {
                createRequesterKeyPair: async () => { throw new Error('not used'); },
                requestAssertion: async () => { throw new Error('not used'); },
                openHomeTransport: async (home) => {
                    const resolved = await resolveHomeEnrollmentTransport(home.connectionDescriptor);
                    if (!resolved.ok) {
                        const retryable = resolved.reason === 'iroh_transport_unavailable';
                        throw new HomeEnrollmentBoundaryError(retryable
                            ? createExplicitResumeContinuation(continuationInput, resolved.reason,
                                input.approvalId && input.approvalExpiresAtMs !== undefined
                                    ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
                                    : undefined)
                            : { kind: 'transport_unavailable', reason: resolved.reason });
                    }
                    if (!resolved.transport.authenticatedCredentialDestination) {
                        throw new HomeEnrollmentBoundaryError({ kind: 'failed' });
                    }
                    return {
                        transport: resolved.transport,
                        authenticatedCredentialDestination:
                            resolved.transport.authenticatedCredentialDestination,
                    };
                },
                observeHomeBeforeRedemption: async ({ transport }) => {
                    const observation = await probeServerFeaturesAtUrl({
                        endpointUrl: transport.endpointUrl,
                        ...(transport.runtimeOrigin ? { runtimeOrigin: transport.runtimeOrigin } : {}),
                        ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                        serverId: targetIdentity,
                        force: true,
                        // Enrollment is not a latency-sensitive diagnostic. Wait for the shared
                        // observation's request-owned safety bound instead of imposing the probe
                        // helper's short interactive wait budget.
                        timeoutMs: 0,
                    });
                    if (observation.status !== 'ready') {
                        throw new HomeEnrollmentBoundaryError(createExplicitResumeContinuation(
                            continuationInput,
                            'home_observation_unavailable',
                            input.approvalId && input.approvalExpiresAtMs !== undefined
                                ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
                                : undefined,
                        ));
                    }
                    const observedIdentity = observation.serverIdentityId
                        ?? observation.features.capabilities.serverIdentity.serverIdentityId;
                    const publishedDescriptor = observation.features.homeConnectionDescriptor;
                    if (!observedIdentity || !publishedDescriptor) {
                        throw new HomeEnrollmentBoundaryError(createExplicitResumeContinuation(
                            continuationInput,
                            'home_observation_unavailable',
                            input.approvalId && input.approvalExpiresAtMs !== undefined
                                ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
                                : undefined,
                        ));
                    }
                    return {
                        homeServerIdentityId: observedIdentity,
                        connectionDescriptor: publishedDescriptor,
                        provenance: 'public',
                    };
                },
                redeemAssertion: async ({ transport, assertion, approvalId }) => {
                    try {
                        return await redeemHomeLoginAssertion(transport, assertion, {
                            ...(approvalId ? { approvalId } : {}),
                        });
                    } catch (error) {
                        const terminal = terminalRedemptionError(error);
                        if (terminal) throw new HomeEnrollmentBoundaryError(terminal);
                        throw new HomeEnrollmentBoundaryError(createExplicitResumeContinuation(
                            continuationInput,
                            'request_failed',
                            input.approvalId && input.approvalExpiresAtMs !== undefined
                                ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
                                : undefined,
                        ));
                    }
                },
                decodeHomeCredential: async ({ redemption, secretKey }) =>
                    decodeHomeCredentialPayload(redemption.sealedHomeTokenBase64Url, secretKey),
                observeAuthenticatedHome: async ({ transport, credential }) => {
                    try {
                        const observation = await observeAuthenticatedServerFeaturesFresh({
                            request: transport.createRequest({
                                serverId: targetIdentity,
                                credentials: { token: credential.token },
                            }),
                        });
                        if (observation.status !== 'ready') {
                            throw new Error('authenticated observation unavailable');
                        }
                        const exactDescriptor = observation.features.homeConnectionDescriptor;
                        const observedIdentity = observation.serverIdentityId;
                        if (!exactDescriptor || !observedIdentity) throw new Error('authenticated descriptor unavailable');
                        return {
                            homeServerIdentityId: observedIdentity,
                            connectionDescriptor: exactDescriptor,
                            provenance: 'authenticated',
                        };
                    } catch {
                        throw new HomeEnrollmentBoundaryError(createExplicitResumeContinuation(
                            continuationInput,
                            'home_observation_unavailable',
                            input.approvalId && input.approvalExpiresAtMs !== undefined
                                ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
                                : undefined,
                        ));
                    }
                },
                commitHomeCredential: async ({ credential }) => {
                    if (!authenticatedDescriptor) {
                        throw new HomeEnrollmentBoundaryError({ kind: 'failed' });
                    }
                    try {
                        const existing = await TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, { serverId: targetIdentity });
                        if (existing && existing.token !== credential.token) {
                            let sameAccount = false;
                            try {
                                sameAccount = parseToken(existing.token) === parseToken(credential.token);
                            } catch {
                                sameAccount = false;
                            }
                            if (!sameAccount) throw new HomeEnrollmentBoundaryError({
                                kind: 'failed', reason: 'account_mismatch',
                            });
                        }
                        // Preserve same-Account material, including recoverable inconsistent
                        // bytes. The post-auth owner validates it after authoritative Account
                        // mode lookup; material repair must not discard this fresh bearer.
                        await adoptHomeProfileWithCredentials({
                            descriptor: authenticatedDescriptor,
                            source: 'account-directory',
                            preserveUserLabel: true,
                            suggestedName: input.home.label,
                            descriptorAuthority: 'current_connection_observation',
                            credentials: { ...existing, token: credential.token },
                            shouldCancel: () => isCancelled(cancellationState),
                        });
                    } catch (error) {
                        if (isHomeProfileAdoptionPartialCommitFailure(error)) {
                            throw new HomeEnrollmentBoundaryError({
                                kind: 'partial_commit',
                                homeServerIdentityId: error.serverIdentityId,
                                canonicalServerUrl: 'canonicalServerUrl' in error
                                    ? error.canonicalServerUrl
                                    : error.toCanonicalServerUrl,
                                error,
                            });
                        }
                        if (error instanceof HomeEnrollmentBoundaryError) throw error;
                        throw new HomeEnrollmentBoundaryError({ kind: 'failed' });
                    }
                },
                reconcileAuthenticatedHome: async ({ observation }) => {
                    let reconciliation = await reconcileServerProfileHomeConnectionDescriptor({
                        serverUrl: descriptor.canonicalServerUrl,
                        observedServerIdentityId: targetIdentity,
                        descriptor: observation.connectionDescriptor,
                        observation: 'exact',
                    });
                    if (reconciliation.kind === 'conflict' && reconciliation.code === 'profile_missing') {
                        await adoptDirectoryHome(input.home);
                        reconciliation = await reconcileServerProfileHomeConnectionDescriptor({
                            serverUrl: descriptor.canonicalServerUrl,
                            observedServerIdentityId: targetIdentity,
                            descriptor: observation.connectionDescriptor,
                            observation: 'exact',
                        });
                    }
                    if (reconciliation.kind !== 'applied' && reconciliation.kind !== 'unchanged') {
                        throw new HomeEnrollmentBoundaryError({ kind: 'failed' });
                    }
                    authenticatedDescriptor = observation.connectionDescriptor;
                },
                closeHomeTransport: async (transport) => await transport.close(),
            },
        });

    if (result.kind === 'enrolled') return { kind: 'enrolled', homeServerIdentityId: targetIdentity };
    if (result.kind === 'cancelled') return result;
    if (result.kind === 'approval_required') {
        return createApprovalContinuation(
            continuationInput,
            result.approval.approvalId,
            Math.min(input.approvalExpiresAtMs ?? result.approval.expiresAtMs, result.approval.expiresAtMs),
        );
    }
    if (result.kind === 'verification_failed') {
        if ('stage' in result && result.stage === 'post_redemption') {
            return createExplicitResumeContinuation(
                continuationInput,
                'home_observation_unavailable',
                input.approvalId && input.approvalExpiresAtMs !== undefined
                    ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
                    : undefined,
            );
        }
        return result.reason === 'redemption_expired' ? { kind: 'expired' } : { kind: 'failed' };
    }
    if (result.error instanceof HomeEnrollmentBoundaryError) return result.error.result;
    return createExplicitResumeContinuation(
        continuationInput,
        'request_failed',
        input.approvalId && input.approvalExpiresAtMs !== undefined
            ? { approvalId: input.approvalId, expiresAtMs: input.approvalExpiresAtMs }
            : undefined,
    );
}
