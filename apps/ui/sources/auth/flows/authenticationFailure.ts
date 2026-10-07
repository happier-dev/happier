import { AccountDirectoryRouteErrorResponseV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { AuthErrorCodeSchema } from '@happier-dev/protocol/auth/errors';
import { HappyError } from '@/utils/errors/errors';

/**
 * Client-side refusal code for a key-challenge proof issued by a Home other
 * than the one this device expects. Origin differences are not a refusal: one
 * Home is legitimately reached through several hostnames, ports and tunnels.
 */
export const HOME_IDENTITY_MISMATCH_AUTH_CODE = 'home-identity-mismatch';

/**
 * Client-side refusal code for a challenge that names an address the selected
 * endpoint did not, on a Home this device has never completed authentication
 * with. At first contact the Home's identity is learned through that same
 * endpoint, so the selected address is the only fact the endpoint cannot choose.
 */
export const HOME_ADDRESS_MISMATCH_AUTH_CODE = 'home-address-mismatch';

export function createHomeAddressMismatchFailure(): HappyError {
    return new HappyError(
        'Authentication failed: the issued key-challenge names an unconfirmed Home address.',
        false,
        { kind: 'auth', code: HOME_ADDRESS_MISMATCH_AUTH_CODE },
    );
}

export function createHomeIdentityMismatchFailure(): HappyError {
    return new HappyError(
        'Authentication failed: the issued key-challenge belongs to a different Home identity.',
        false,
        { kind: 'auth', code: HOME_IDENTITY_MISMATCH_AUTH_CODE },
    );
}

/** Preserve only public error codes, never server diagnostic text. */
export function createAuthenticationFailure(
    status: number,
    payload: unknown,
    target: 'ordinary_home' | 'account_directory' = 'ordinary_home',
): HappyError {
    const candidate = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { error?: unknown }).error
        : undefined;
    const parsed = AuthErrorCodeSchema.safeParse(candidate);
    let code: string | undefined = parsed.success ? parsed.data : undefined;
    if (!code && target === 'account_directory') {
        const directoryError = AccountDirectoryRouteErrorResponseV1Schema.safeParse(payload);
        if (directoryError.success) code = directoryError.data.error;
    }
    const isServerFailure = status >= 500;
    return new HappyError(`Authentication failed: ${status}`, isServerFailure, {
        status,
        kind: isServerFailure ? 'server' : 'auth',
        ...(code ? { code } : {}),
    });
}
