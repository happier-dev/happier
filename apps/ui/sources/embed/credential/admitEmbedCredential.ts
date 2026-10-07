import { ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, AccountApiTokenSelfV1Schema, type AccountApiTokenSelfV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { isOriginAllowedByApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ServerFetch } from '@/sync/http/client';

export async function admitEmbedCredential(input: Readonly<{
    request: ServerFetch; parentOrigin: string; ancestorOrigins: readonly string[];
}>): Promise<AccountApiTokenSelfV1> {
    const response = await input.request(ACCOUNT_API_TOKEN_SELF_HTTP_PATH_V1, { method: 'GET' }, { retry: 'none' });
    if (!response.ok) throw new Error('credential_rejected');
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error('credential_rejected'); }
    const parsed = AccountApiTokenSelfV1Schema.safeParse(value);
    if (!parsed.success) throw new Error('credential_rejected');
    const origins = [input.parentOrigin, ...input.ancestorOrigins];
    if (origins.some((origin) => !isOriginAllowedByApiTokenGrantV1(parsed.data.grant, origin))) {
        throw new Error('origin_not_allowed');
    }
    return parsed.data;
}
