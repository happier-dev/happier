import {
    ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
    ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
    AccountApiTokensCreateActionInputV1Schema,
    AccountApiTokensCreateActionOutputV1Schema,
    AccountApiTokensListActionInputV1Schema,
    AccountApiTokensListActionOutputV1Schema,
    AccountApiTokensRevokeActionInputV1Schema,
    AccountApiTokensRevokeActionOutputV1Schema,
    AccountApiTokensRevokeAllActionInputV1Schema,
    AccountApiTokensRevokeAllActionOutputV1Schema,
    type AccountApiTokensCreateActionInputV1,
    type AccountApiTokensCreateActionOutputV1,
    type AccountApiTokensListActionInputV1,
    type AccountApiTokensListActionOutputV1,
    type AccountApiTokensRevokeActionInputV1,
    type AccountApiTokensRevokeActionOutputV1,
    type AccountApiTokensRevokeAllActionInputV1,
    type AccountApiTokensRevokeAllActionOutputV1,
} from '@happier-dev/protocol';
import type { z } from 'zod';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

export type CurrentAccountApiTokensOptionsV1 = Readonly<{
    /** The host Action can abandon its pending request without changing Account scope. */
    signal?: AbortSignal;
}>;

type CapturedActiveAccountApiTokens = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>;
}>;

const UNAVAILABLE_MESSAGE = 'account_api_tokens_unavailable';

function unavailable(): never {
    throw new Error(UNAVAILABLE_MESSAGE);
}

function isCurrent(captured: CapturedActiveAccountApiTokens): boolean {
    const current = getActiveServerSnapshot();
    return captured.lifetime.isCurrent()
        && current.serverId === captured.serverSnapshot.serverId
        && current.generation === captured.serverSnapshot.generation;
}

function captureActiveAccountApiTokens(): CapturedActiveAccountApiTokens | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !lifetime.isCurrent()) return null;
    const serverSnapshot = getActiveServerSnapshot();
    if (serverSnapshot.serverId !== lifetime.scope.serverId) return null;
    return { lifetime, serverSnapshot };
}

async function requestCurrentAccountApiTokens<
    TInputSchema extends z.ZodType,
    TOutputSchema extends z.ZodType,
>(
    path: string,
    input: z.input<TInputSchema>,
    inputSchema: TInputSchema,
    outputSchema: TOutputSchema,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<z.output<TOutputSchema>> {
    const request = inputSchema.parse(input);
    if (options?.signal?.aborted) return unavailable();

    const captured = captureActiveAccountApiTokens();
    if (!captured) return unavailable();

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = captured.lifetime.onRetire(abort);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();

    try {
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();

        const authority = await captureSessionRequestAuthorityForServerAccountScope({
            scope: captured.lifetime.scope,
            activeRequest: (requestPath, init) => apiSocket.request(requestPath, init),
        });
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();

        const response = await authority.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal: controller.signal,
        });
        if (controller.signal.aborted || !isCurrent(captured) || !response.ok) return unavailable();

        const parsed = outputSchema.safeParse(await response.json());
        if (controller.signal.aborted || !isCurrent(captured) || !parsed.success) return unavailable();
        return parsed.data;
    } catch {
        return unavailable();
    } finally {
        options?.signal?.removeEventListener('abort', abort);
        retirement.dispose();
    }
}

/**
 * Action transport for the active Account only. The Account is captured from
 * the current scoped credential and is never accepted as an input or URL part.
 */
export async function createCurrentAccountApiToken(
    input: AccountApiTokensCreateActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<AccountApiTokensCreateActionOutputV1> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        input,
        AccountApiTokensCreateActionInputV1Schema,
        AccountApiTokensCreateActionOutputV1Schema,
        options,
    );
}

export async function listCurrentAccountApiTokens(
    input: AccountApiTokensListActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<AccountApiTokensListActionOutputV1> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
        input,
        AccountApiTokensListActionInputV1Schema,
        AccountApiTokensListActionOutputV1Schema,
        options,
    );
}

export async function revokeCurrentAccountApiToken(
    input: AccountApiTokensRevokeActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<AccountApiTokensRevokeActionOutputV1> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        input,
        AccountApiTokensRevokeActionInputV1Schema,
        AccountApiTokensRevokeActionOutputV1Schema,
        options,
    );
}

export async function revokeAllCurrentAccountApiTokens(
    input: AccountApiTokensRevokeAllActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<AccountApiTokensRevokeAllActionOutputV1> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        input,
        AccountApiTokensRevokeAllActionInputV1Schema,
        AccountApiTokensRevokeAllActionOutputV1Schema,
        options,
    );
}
