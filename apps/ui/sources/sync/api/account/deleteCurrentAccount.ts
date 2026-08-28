import {
    ACCOUNT_ERASURE_CONFIRMATION_V1,
    ACCOUNT_ERASURE_HTTP_PATH_V1,
    AccountErasureErrorV1Schema,
    AccountErasureResponseV1Schema,
    type AccountErasureResponseV1,
} from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
export async function deleteCurrentAccount(credentials: Pick<AuthCredentials, 'token'>): Promise<AccountErasureResponseV1> {
    const response = await serverFetch(
        ACCOUNT_ERASURE_HTTP_PATH_V1,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1 }),
        },
        { includeAuth: false },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = AccountErasureErrorV1Schema.safeParse(payload);
        const code = parsed.success ? parsed.data.error : 'account_delete_failed';
        throw new HappyError(code, true, {
            status: response.status,
            kind: response.status === 403 ? 'auth' : 'server',
            code,
        });
    }
    const parsed = AccountErasureResponseV1Schema.safeParse(payload);
    if (!parsed.success) {
        throw new HappyError('account_delete_invalid_response', true, {
            status: response.status,
            kind: 'server',
            code: 'account_delete_invalid_response',
        });
    }
    return parsed.data;
}
