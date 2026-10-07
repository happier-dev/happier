import {
    NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1,
    NATIVE_AUTH_EMAIL_LOGIN_PATH_V1,
    NATIVE_AUTH_EMAIL_UNLOCK_PATH_V1,
    NativeEmailPasswordPreloginRequestV1Schema,
    NativeEmailPasswordPreloginResponseV1Schema,
    NativeEmailPasswordLoginRequestV1Schema,
    NativeEmailPasswordLoginResponseV1Schema,
    NativeEmailPasswordUnlockRequestV1Schema,
    NativeEmailPasswordUnlockResponseV1Schema,
    NativeEmailPasswordErrorResponseV1Schema,
    type NativeEmailPasswordLoginRequestV1,
    type NativeEmailPasswordUnlockRequestV1,
} from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';

import type { ServerFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';

async function post(request: ServerFetch, path: string, body: unknown): Promise<unknown> {
    const response = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, { includeAuth: false, retry: 'none' });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = NativeEmailPasswordErrorResponseV1Schema.safeParse(payload);
        throw new HappyError('Password authentication failed', response.status >= 500 || response.status === 429, {
            kind: response.status >= 500 ? 'server' : 'auth',
            status: response.status,
            ...(parsed.success ? { code: parsed.data.error } : {}),
        });
    }
    return payload;
}

export async function preloginEmailPassword(request: ServerFetch, email: string) {
    const body = NativeEmailPasswordPreloginRequestV1Schema.parse({ v: 1, email });
    return NativeEmailPasswordPreloginResponseV1Schema.parse(await post(request, NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1, body));
}

export async function authenticatePlainPassword(request: ServerFetch, input: NativeEmailPasswordLoginRequestV1) {
    return NativeEmailPasswordLoginResponseV1Schema.parse(await post(
        request, NATIVE_AUTH_EMAIL_LOGIN_PATH_V1, NativeEmailPasswordLoginRequestV1Schema.parse(input),
    ));
}

export async function unlockEmailPassword(request: ServerFetch, input: NativeEmailPasswordUnlockRequestV1) {
    return NativeEmailPasswordUnlockResponseV1Schema.parse(await post(
        request, NATIVE_AUTH_EMAIL_UNLOCK_PATH_V1, NativeEmailPasswordUnlockRequestV1Schema.parse(input),
    ));
}
