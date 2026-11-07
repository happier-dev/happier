import {
    APP_LOCK_RECOVERY_ROUTES,
    AppLockRecoveryErrorResponseSchema,
    AppLockRecoveryRedeemResponseSchema,
    AppLockMailSettingsResponseSchema,
    type AppLockMailSettings,
    type AppLockMailSettingsInput,
    type AppLockRecoveryCodeRequest,
    type AppLockRecoveryErrorCode,
    type AppLockRecoveryLockRequest,
    type AppLockRecoveryRegisterRequest,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

export type AppLockRecoveryFailure = Readonly<{
    ok: false;
    /** `network`: no response; `server`: the relay answered with an unexpected error or payload. */
    error: AppLockRecoveryErrorCode | 'network' | 'server';
    retryAfterSeconds?: number;
}>;

export type AppLockRecoveryResult<T = {}> = (Readonly<{ ok: true }> & T) | AppLockRecoveryFailure;

async function readFailure(response: Response): Promise<AppLockRecoveryFailure> {
    const body: unknown = await response.json().catch(() => null);
    const parsed = AppLockRecoveryErrorResponseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'server' };
    return parsed.data.retryAfterSeconds !== undefined
        ? { ok: false, error: parsed.data.error, retryAfterSeconds: parsed.data.retryAfterSeconds }
        : { ok: false, error: parsed.data.error };
}

async function post(path: string, body: unknown, options: Parameters<typeof serverFetch>[2], method: 'POST' | 'PUT' = 'POST'): Promise<Response | null> {
    try {
        return await serverFetch(path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, options);
    } catch (error) {
        console.error('[appLock] Relay request failed:', error instanceof Error ? error.message : String(error));
        return null;
    }
}

function publicUrl(serverUrl: string, path: string): string {
    return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

/** Authenticated (active server): store the escrow and email a verification code. */
export async function apiAppLockRecoveryRegister(request: AppLockRecoveryRegisterRequest): Promise<AppLockRecoveryResult> {
    const response = await post(APP_LOCK_RECOVERY_ROUTES.register, request, {});
    if (!response) return { ok: false, error: 'network' };
    return response.ok ? { ok: true } : await readFailure(response);
}


/** Authenticated (active server): forget an escrow. */
export async function apiAppLockRecoveryRemove(request: AppLockRecoveryLockRequest): Promise<AppLockRecoveryResult> {
    const response = await post(APP_LOCK_RECOVERY_ROUTES.remove, request, {});
    if (!response) return { ok: false, error: 'network' };
    return response.ok ? { ok: true } : await readFailure(response);
}

/**
 * Public: email a reset code. Runs from the lock screen before the app has booted, so it goes
 * straight to the escrow's relay without credentials or connectivity supervision.
 */
export async function apiAppLockRecoveryRequestResetCode(serverUrl: string, request: AppLockRecoveryLockRequest): Promise<AppLockRecoveryResult> {
    const response = await post(publicUrl(serverUrl, APP_LOCK_RECOVERY_ROUTES.requestResetCode), request, { includeAuth: false, retry: 'none' });
    if (!response) return { ok: false, error: 'network' };
    return response.ok ? { ok: true } : await readFailure(response);
}

/** Public: trade a reset code for the recovery key. */
export async function apiAppLockRecoveryRedeem(
    serverUrl: string,
    request: AppLockRecoveryCodeRequest,
): Promise<AppLockRecoveryResult<{ recoveryKey: string }>> {
    const response = await post(publicUrl(serverUrl, APP_LOCK_RECOVERY_ROUTES.redeemResetCode), request, { includeAuth: false, retry: 'none' });
    if (!response) return { ok: false, error: 'network' };
    if (!response.ok) return await readFailure(response);
    const parsed = AppLockRecoveryRedeemResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, recoveryKey: parsed.data.recoveryKey } : { ok: false, error: 'server' };
}

/** Authenticated (active server): the account's SMTP settings for reset emails, without the password. */
export async function apiAppLockMailSettingsGet(): Promise<AppLockRecoveryResult<{ settings: AppLockMailSettings | null }>> {
    let response: Response;
    try {
        response = await serverFetch(APP_LOCK_RECOVERY_ROUTES.mailSettings, { method: 'GET' }, {});
    } catch (error) {
        console.error('[appLock] Relay request failed:', error instanceof Error ? error.message : String(error));
        return { ok: false, error: 'network' };
    }
    if (!response.ok) return await readFailure(response);
    const parsed = AppLockMailSettingsResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, settings: parsed.data.settings } : { ok: false, error: 'server' };
}

/** Authenticated (active server): save the account's SMTP settings. Omit `password` to keep the saved one. */
export async function apiAppLockMailSettingsSave(settings: AppLockMailSettingsInput): Promise<AppLockRecoveryResult> {
    const response = await post(APP_LOCK_RECOVERY_ROUTES.mailSettings, settings, {}, 'PUT');
    if (!response) return { ok: false, error: 'network' };
    return response.ok ? { ok: true } : await readFailure(response);
}

/** Authenticated (active server): send a test email to the saved account-wide recovery address. */
export async function apiAppLockMailSettingsSendTest(): Promise<AppLockRecoveryResult> {
    const response = await post(APP_LOCK_RECOVERY_ROUTES.mailSettingsTest, {}, {});
    if (!response) return { ok: false, error: 'network' };
    return response.ok ? { ok: true } : await readFailure(response);
}
