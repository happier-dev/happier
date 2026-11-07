import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

export const DEVICE_AUTHENTICATION_VENDOR_ORIGIN = 'https://device-authentication-vendor.test';

function readBody(bytes: Uint8Array): Record<string, unknown> {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fixture_vendor_response_invalid');
    return value as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (typeof value !== 'string' || !value) throw new Error('fixture_vendor_response_invalid');
    return value;
}

function readPositiveNumber(body: Record<string, unknown>, key: string): number {
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('fixture_vendor_response_invalid');
    return value;
}

const deviceModes = { device: {
        kind: 'oauthDeviceCode',
        async begin(context) {
            const response = await context.services.http.request({ url: `${DEVICE_AUTHENTICATION_VENDOR_ORIGIN}/device`,
                method: 'POST', redirect: 'error' }, { signal: context.signal });
            if (response.status !== 200) throw new Error('fixture_vendor_begin_failed');
            const body = readBody(response.body);
            await context.attemptCredentials.set('deviceCode', readString(body, 'device_code'), { signal: context.signal });
            return { status: 'awaitingDeviceAuthorization', verificationUri: readString(body, 'verification_uri'),
                userCode: readString(body, 'user_code'), expiresAtMs: Date.now() + readPositiveNumber(body, 'expires_in') * 1_000,
                pollIntervalMs: readPositiveNumber(body, 'interval') * 1_000 };
        },
        async poll(context) {
            const deviceCode = await context.attemptCredentials.get('deviceCode', { signal: context.signal });
            if (!deviceCode) throw new Error('fixture_device_code_unavailable');
            const response = await context.services.http.request({ url: `${DEVICE_AUTHENTICATION_VENDOR_ORIGIN}/token`,
                method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
                body: new TextEncoder().encode(JSON.stringify({ device_code: deviceCode })) }, { signal: context.signal });
            if (response.status !== 200) throw new Error('fixture_vendor_poll_failed');
            const body = readBody(response.body);
            if (body.status === 'pending') return { status: 'pending', retryAfterMs: readPositiveNumber(body, 'retry_after_ms') };
            await context.attemptCredentials.set('accessToken', readString(body, 'access_token'), { signal: context.signal });
            await context.attemptCredentials.delete('deviceCode', { signal: context.signal });
            return { status: 'connected', accountId: 'device-example-account', displayName: 'Device example', scopes: [] };
        },
        async cancel() {},
    } } satisfies ConnectedAccountAuthenticationRuntime['authentication']['modes'];

/** Private authored plugin: the host supplies all lifecycle, custody and IO. */
export const deviceAuthentication: ConnectedAccountAuthenticationRuntime = {
    authentication: { modes: { ...deviceModes, 'configured-device': deviceModes.device } },
};

export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register('example', deviceAuthentication);
}
