import {
    ACCOUNT_ERASURE_CONFIRMATION_V1,
    ACCOUNT_ERASURE_HTTP_PATH_V1,
    AccountErasureErrorV1Schema,
    AccountErasureRequestV1Schema,
    AccountErasureResponseV1Schema,
    type AccountErasureResponseV1,
    type AccountErasureRequestV1,
} from '@happier-dev/protocol/auth/accountErasure';
import type { ManagedResourceDependencyV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';

export class AccountErasureManagedResourcesReviewRequiredError extends HappyError {
    readonly resources: readonly ManagedResourceDependencyV1[];
    constructor(resources: readonly ManagedResourceDependencyV1[]) {
        super('account_erasure_managed_resources_review_required', true, { status: 409, kind: 'server', code: 'account_erasure_managed_resources_review_required' });
        this.resources = resources;
        Object.setPrototypeOf(this, AccountErasureManagedResourcesReviewRequiredError.prototype);
    }
}
export type DeleteCurrentAccountOptions = Readonly<{
    managedResourceDispositions?: AccountErasureRequestV1['managedResourceDispositions'];
    signal?: AbortSignal;
    request?: ServerFetch;
}>;
export async function deleteCurrentAccount(credentials: Pick<AuthCredentials, 'token'>, options?: DeleteCurrentAccountOptions): Promise<AccountErasureResponseV1> {
    const input = AccountErasureRequestV1Schema.parse({ confirmation: ACCOUNT_ERASURE_CONFIRMATION_V1,
        ...(options?.managedResourceDispositions ? { managedResourceDispositions: options.managedResourceDispositions } : {}) });
    const response = await (options?.request ?? serverFetch)(
        ACCOUNT_ERASURE_HTTP_PATH_V1,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(input),
            ...(options?.signal ? { signal: options.signal } : {}),
        },
        { includeAuth: false },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const parsed = AccountErasureErrorV1Schema.safeParse(payload);
        if (response.status === 409 && parsed.success && parsed.data.error === 'account_erasure_managed_resources_review_required') {
            throw new AccountErasureManagedResourcesReviewRequiredError(parsed.data.resources);
        }
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
