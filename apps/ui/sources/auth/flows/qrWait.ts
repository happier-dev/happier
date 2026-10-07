import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { QRAuthKeyPair, type HomeQrEnrollmentTarget } from './qrStart';
import { decryptBox } from '@/encryption/libsodium';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { openTerminalProvisioningV3Response } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import type { HomeQrInviteDirectionV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import tweetnacl from 'tweetnacl';
import {
    ENROLLMENT_POLL_IDLE_DELAY_MS,
    enrollmentPollingBackoffMs,
} from '@/auth/enrollment/enrollmentPollingBackoff';
import { trackAuthEnrollmentTransientRetry } from '@/track';

export type { AuthCredentials } from '@/auth/storage/tokenStorage';
export type { HomeQrEnrollmentTarget } from './qrStart';

/** Terminal, user-actionable wait outcomes. Credentials never appear in failures. */
export type AuthQrWaitTerminalReason =
    | 'cancelled'
    | 'expired'
    | 'rejected'
    | 'wrong_target'
    | 'malformed_response'
    | 'update_required';

export type AuthQrWaitResult =
    | Readonly<{ ok: true; credentials: AuthCredentials; homeServerIdentityId: string | null }>
    | Readonly<{ ok: false; reason: AuthQrWaitTerminalReason }>;

export type AuthQrWaitOptions = Readonly<{
    onProgress?: (dots: number) => void;
    shouldCancel?: () => boolean;
    /** Cancels the currently in-flight target request as well as future polls. */
    signal?: AbortSignal;
    /** Enrollment deadline; polling never continues past it. */
    expiresAtMs?: number;
    v2Context?: Readonly<{
        direction: HomeQrInviteDirectionV2;
        pairId: string;
        homeServerIdentityId: string;
        bindingSecret: Uint8Array;
        bindingProof: string;
        issuedAtMs: number;
        expiresAtMs: number;
    }>;
}>;

// Bounded payload limits for the authorized account-auth response.
const TOKEN_ENCRYPTED_MAX_CHARS = 8_192;
const RESPONSE_MAX_CHARS = 8_192;

function decodeBoundedBase64(value: unknown, maxChars: number): Uint8Array | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return null;
    try {
        const decoded = decodeBase64(value);
        return encodeBase64(decoded) === value ? decoded : null;
    } catch {
        return null;
    }
}

function decodeUtf8Strict(value: Uint8Array): string | null {
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
        return decoded.length > 0 && decoded.trim() === decoded ? decoded : null;
    } catch {
        return null;
    }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function waitForNextPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return true;
    }
    if (signal.aborted) return false;

    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (completed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(completed);
        };
        const onAbort = () => finish(false);
        const timer = setTimeout(() => finish(true), ms);
        signal.addEventListener('abort', onAbort, { once: true });
        // Abort can race the listener registration between the check above and this point.
        if (signal.aborted) onAbort();
    });
}

function clampPollDelayToExpiry(delayMs: number, expiresAtMs: number | undefined): number {
    if (expiresAtMs === undefined) return delayMs;
    return Math.max(0, Math.min(delayMs, expiresAtMs - Date.now()));
}

/**
 * Poll the explicit target Home until it authorizes this device's enrollment. Transport
 * failures retry with bounded backoff and jitter until the deadline; malformed, oversized,
 * unbound-legacy, and wrong-target responses fail closed with typed reasons.
 */
export async function authQRWait(
    keypair: QRAuthKeyPair,
    target: HomeQrEnrollmentTarget,
    options: AuthQrWaitOptions = {},
): Promise<AuthQrWaitResult> {
    const { onProgress, shouldCancel, signal } = options;
    const context = options.v2Context;
    const expiresAtMs = context?.expiresAtMs ?? options.expiresAtMs;
    let dots = 0;
    let transientFailures = 0;

    if (
        !context
        || !target.descriptor
        || context.homeServerIdentityId !== target.descriptor.homeServerIdentityId
        || context.bindingSecret.length !== 32
        || !context.bindingProof
        || !Number.isSafeInteger(context.issuedAtMs)
        || !Number.isSafeInteger(context.expiresAtMs)
        || context.expiresAtMs <= context.issuedAtMs
    ) {
        return { ok: false, reason: 'update_required' };
    }

    const requestAtEndpoint = target.createRequest({
        ...(target.serverId ? { serverId: target.serverId } : {}),
        credentials: null,
    });

    const terminal = (reason: AuthQrWaitTerminalReason): AuthQrWaitResult => ({ ok: false, reason });

    while (true) {
        if (signal?.aborted || shouldCancel?.()) return terminal('cancelled');
        if (expiresAtMs !== undefined && Date.now() >= expiresAtMs) return terminal('expired');

        if (!isRuntimeActive()) {
            const inactiveWaitMs = clampPollDelayToExpiry(1_000, expiresAtMs);
            if (inactiveWaitMs === 0) return terminal('expired');
            if (!await waitForNextPoll(inactiveWaitMs, signal)) return terminal('cancelled');
            continue;
        }

        try {
            const requestController = new AbortController();
            const abortRequest = () => requestController.abort();
            signal?.addEventListener('abort', abortRequest, { once: true });
            const remainingMs = expiresAtMs === undefined ? null : Math.max(0, expiresAtMs - Date.now());
            const deadlineTimer = remainingMs === null ? null : setTimeout(abortRequest, remainingMs);
            let response: Response;
            try {
                response = await requestAtEndpoint('/v2/auth/account/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    publicKey: encodeBase64(keypair.publicKey),
                    pairId: context.pairId,
                    homeServerIdentityId: context.homeServerIdentityId,
                }),
                    signal: requestController.signal,
                }, { includeAuth: false, retry: 'none' });
            } finally {
                if (deadlineTimer) clearTimeout(deadlineTimer);
                signal?.removeEventListener('abort', abortRequest);
            }
            if (!response.ok) {
                if (response.status === 404 || response.status === 410) return terminal('expired');
                if (response.status === 403) return terminal('wrong_target');
                if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                    return terminal('malformed_response');
                }
                transientFailures += 1;
                trackAuthEnrollmentTransientRetry();
            } else {
                const data: unknown = await response.json().catch(() => null);
                if (!data || typeof data !== 'object') {
                    return terminal('malformed_response');
                }
                const record = data as Record<string, unknown>;
                if (record.state === 'requested') {
                    if (!hasExactKeys(record, ['state'])) return terminal('malformed_response');
                    transientFailures = 0;
                } else if (record.state === 'rejected') {
                    if (!hasExactKeys(record, ['state'])) return terminal('malformed_response');
                    return terminal('rejected');
                } else if (record.state === 'authorized') {
                    if (!hasExactKeys(record, ['state', 'tokenEncrypted', 'response'])) {
                        return terminal('malformed_response');
                    }
                    transientFailures = 0;

                    const tokenEncryptedBytes = decodeBoundedBase64(record.tokenEncrypted, TOKEN_ENCRYPTED_MAX_CHARS);
                    if (!tokenEncryptedBytes) return terminal('malformed_response');
                    const openedToken = decryptBox(tokenEncryptedBytes, keypair.secretKey);
                    if (!openedToken || openedToken.length === 0 || openedToken.length > 4_096) {
                        return terminal('malformed_response');
                    }
                    const token = decodeUtf8Strict(openedToken);
                    if (!token) return terminal('malformed_response');

                    const responseBytes = decodeBoundedBase64(record.response, RESPONSE_MAX_CHARS);
                    if (!responseBytes) return terminal('malformed_response');
                    const material = openTerminalProvisioningV3Response({
                        payload: responseBytes,
                        recipientSecretKeyOrSeed: keypair.secretKey,
                        terminalEphemeralPublicKey: keypair.publicKey,
                        pairingSecret: context.bindingSecret,
                        createdAtMs: context.issuedAtMs,
                        expiresAtMs: context.expiresAtMs,
                        nowMs: Date.now(),
                    });
                    if (!material) return terminal('malformed_response');

                    const credentials: AuthCredentials = material.type === 'tokenOnly'
                        ? { token }
                        : {
                            token,
                            encryption: {
                                machineKey: encodeBase64(material.key),
                                publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(material.key).publicKey),
                            },
                        };

                    return {
                        ok: true,
                        credentials,
                        homeServerIdentityId: context.homeServerIdentityId,
                    };
                } else {
                    return terminal('malformed_response');
                }
            }
        } catch {
            if (signal?.aborted || shouldCancel?.()) return terminal('cancelled');
            if (expiresAtMs !== undefined && Date.now() >= expiresAtMs) return terminal('expired');
            // Polling is long-lived; transport failures must not discard an otherwise
            // valid pairing. Payload-level problems above return terminal results
            // directly instead of throwing.
            transientFailures += 1;
            trackAuthEnrollmentTransientRetry();
        }

        onProgress?.(dots);
        dots += 1;

        const waitMs = transientFailures > 0
            ? enrollmentPollingBackoffMs(transientFailures)
            : ENROLLMENT_POLL_IDLE_DELAY_MS;
        const boundedWaitMs = clampPollDelayToExpiry(waitMs, expiresAtMs);
        if (boundedWaitMs === 0) return terminal('expired');
        if (!await waitForNextPoll(boundedWaitMs, signal)) return terminal('cancelled');
    }
}
