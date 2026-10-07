import { NATIVE_AUTH_EMAIL_VERIFY_PREVIEW_PATH_V1, NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_PREVIEW_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_REQUEST_PATH_V1, NativeAuthBearerPreviewRequestV1Schema, NativeAuthEmailAcceptedResponseV1Schema, NativeEmailPasswordErrorResponseV1Schema, NativeEmailVerifyPreviewResponseV1Schema, NativeEmailVerifyRequestV1Schema, NativePasswordResetPreviewResponseV1Schema, NativePasswordResetRequestV1Schema, type NativeEmailVerifyPreviewResponseV1, type NativePasswordResetPreviewResponseV1 } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1, PlainPasswordResetSubmitRequestV1Schema, PlainPasswordResetSubmitResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import type { TeamInvitationAccountAdmissionV1 } from '@happier-dev/protocol/auth/accountAdmission';
import { maskEmailForNativeAuthPreview } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';
import { z } from 'zod';

import type { ServerFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';

/**
 * What this client still knows about a mailbox-proof it just requested.
 *
 * `admission` is present only for a transferable invitation; ordinary self-service creation
 * proves the same mailbox and keeps the same normalized address, so the landing screen can
 * bring the verified email back to the panel instead of asking for it again.
 */
export type NativeEmailVerificationContinuation = Readonly<{
    homeServerIdentityId: string;
    normalizedEmail: string;
    admission?: TeamInvitationAccountAdmissionV1;
}>;

// A mail link can navigate away from the Join screen within the same running
// client. Retain only that process-local continuation here, beside the request
// and landing owners; a restarted/lost client safely falls back to the server-
// bound verification operation and never guesses or persists an invitation bearer.
let emailVerificationContinuation: NativeEmailVerificationContinuation | null = null;

export function rememberNativeEmailVerificationContinuation(
    continuation: NativeEmailVerificationContinuation,
): void {
    emailVerificationContinuation = continuation;
}

export function readNativeEmailVerificationContinuation(input: Readonly<{
    homeServerIdentityId: string;
    maskedDestination: string | null;
}>): NativeEmailVerificationContinuation | null {
    if (!emailVerificationContinuation
        || emailVerificationContinuation.homeServerIdentityId !== input.homeServerIdentityId
        || input.maskedDestination === null) return null;
    return maskEmailForNativeAuthPreview(emailVerificationContinuation.normalizedEmail) === input.maskedDestination
        ? emailVerificationContinuation
        : null;
}

export function clearNativeEmailVerificationContinuation(
    continuation: NativeEmailVerificationContinuation,
): void {
    const current = emailVerificationContinuation;
    if (!current) return;
    if (current.homeServerIdentityId !== continuation.homeServerIdentityId) return;
    if (current.normalizedEmail !== continuation.normalizedEmail) return;
    if (current.admission?.token !== continuation.admission?.token) return;
    emailVerificationContinuation = null;
}

async function post(request: ServerFetch, path: string, body: unknown): Promise<unknown> {
    const response = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, { includeAuth: false, retry: 'none' });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = NativeEmailPasswordErrorResponseV1Schema.safeParse(payload);
        const fallback = z.object({ error: z.string() }).safeParse(payload);
        const operationRequiresUpdate = response.status === 404 || response.status === 405 || response.status === 501;
        throw new HappyError('Native email operation failed', !operationRequiresUpdate && (response.status >= 500 || response.status === 429), {
            kind: !operationRequiresUpdate && response.status >= 500 ? 'server' : 'auth',
            status: response.status,
            ...(operationRequiresUpdate
                ? { code: 'client_update_required' }
                : parsed.success
                ? { code: parsed.data.error }
                : fallback.success ? { code: fallback.data.error } : {}),
        });
    }
    return payload;
}

/**
 * Ask the Home to send a verification link. The response is deliberately the
 * same neutral acceptance for claimed, unknown, disabled and ineligible
 * addresses, so no caller may branch on Account existence.
 */
export async function requestNativeEmailVerification(
    request: ServerFetch,
    input: Readonly<{
        email: string;
        continuationId?: string;
        admission?: TeamInvitationAccountAdmissionV1;
        /** Proving the mailbox to create an account-service sign-in; the mailed link says so. */
        purpose?: 'account_service';
    }>,
): Promise<void> {
    NativeAuthEmailAcceptedResponseV1Schema.parse(await post(
        request,
        NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1,
        NativeEmailVerifyRequestV1Schema.parse({
            v: 1,
            email: input.email,
            ...(input.continuationId ? { continuationId: input.continuationId } : {}),
            ...(input.admission ? { admission: input.admission } : {}),
            ...(input.purpose ? { purpose: input.purpose } : {}),
        }),
    ));
}

/** Existence-neutral Plain password reset request. */
export async function requestNativePasswordReset(request: ServerFetch, email: string): Promise<void> {
    NativeAuthEmailAcceptedResponseV1Schema.parse(await post(
        request,
        NATIVE_AUTH_PASSWORD_RESET_REQUEST_PATH_V1,
        NativePasswordResetRequestV1Schema.parse({ v: 1, email }),
    ));
}

/** Read-only landing preview. Opening a link never consumes the bearer. */
export async function previewNativeEmailVerification(
    request: ServerFetch,
    token: string,
): Promise<NativeEmailVerifyPreviewResponseV1> {
    return NativeEmailVerifyPreviewResponseV1Schema.parse(await post(
        request,
        NATIVE_AUTH_EMAIL_VERIFY_PREVIEW_PATH_V1,
        NativeAuthBearerPreviewRequestV1Schema.parse({ v: 1, token }),
    ));
}

export async function previewNativePasswordReset(
    request: ServerFetch,
    token: string,
): Promise<NativePasswordResetPreviewResponseV1> {
    return NativePasswordResetPreviewResponseV1Schema.parse(await post(
        request,
        NATIVE_AUTH_PASSWORD_RESET_PREVIEW_PATH_V1,
        NativeAuthBearerPreviewRequestV1Schema.parse({ v: 1, token }),
    ));
}

/** Consume the reset bearer and replace the Plain password credential. */
export async function submitNativePasswordReset(
    request: ServerFetch,
    input: Readonly<{ token: string; password: string }>,
): Promise<void> {
    PlainPasswordResetSubmitResponseV1Schema.parse(await post(
        request,
        NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1,
        PlainPasswordResetSubmitRequestV1Schema.parse({ v: 1, ...input }),
    ));
}
