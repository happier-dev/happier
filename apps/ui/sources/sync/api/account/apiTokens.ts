import { ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, AccountApiTokensCreateActionInputV1Schema, AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensListActionInputV1Schema, AccountApiTokensListActionOutputV1Schema, AccountApiTokensRevokeActionInputV1Schema, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensRevokeAllActionInputV1Schema, AccountApiTokensRevokeAllActionOutputV1Schema, AccountApiTokensServerErrorV1Schema, AccountApiTokensUpdateActionInputV1Schema, AccountApiTokensUpdateActionOutputV1Schema, type AccountApiTokensCreateActionInputV1, type AccountApiTokensCreateActionOutputV1, type AccountApiTokensListActionInputV1, type AccountApiTokensListActionOutputV1, type AccountApiTokensRevokeActionInputV1, type AccountApiTokensRevokeActionOutputV1, type AccountApiTokensRevokeAllActionInputV1, type AccountApiTokensRevokeAllActionOutputV1, type AccountApiTokensUpdateActionInputV1, type AccountApiTokensUpdateActionOutputV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { z } from 'zod';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

export type CurrentAccountApiTokensOptionsV1 = Readonly<{
    /** The host Action can abandon its pending request without changing Account scope. */
    signal?: AbortSignal;
}>;

type CapturedActiveAccountApiTokens = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>;
}>;

const UNAVAILABLE_MESSAGE = 'account_api_tokens_unavailable';

type CurrentAccountApiTokensResult<T> = T | ActionExecuteFailure;

function unavailable(): never {
    throw new Error(UNAVAILABLE_MESSAGE);
}

function networkFailure(): ActionExecuteFailure {
    return { ok: false, errorCode: 'network_error', error: 'network_error' };
}

function outcomeUnknown(): ActionExecuteFailure {
    return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
}

function invalidResponse(): ActionExecuteFailure {
    return { ok: false, errorCode: 'invalid_response', error: 'invalid_response' };
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
    effect: 'read' | 'write' = 'read',
): Promise<CurrentAccountApiTokensResult<z.output<TOutputSchema>>> {
    const request = inputSchema.parse(input);
    if (options?.signal?.aborted) return unavailable();

    const captured = captureActiveAccountApiTokens();
    if (!captured) return unavailable();

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = captured.lifetime.onRetire(abort);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    let authority: Awaited<ReturnType<typeof captureServerRequestAuthorityForServerAccountScope>> | null = null;
    let issued = false;

    const transportFailure = (): ActionExecuteFailure =>
        effect === 'write' && issued ? outcomeUnknown() : networkFailure();

    try {
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();
        authority = await captureServerRequestAuthorityForServerAccountScope({
            scope: captured.lifetime.scope,
            activeRequest: (requestPath, init) => apiSocket.request(requestPath, init),
        });
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();

        let response: Response;
        try {
            response = await authority.request(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            }, { onIssued: () => { issued = true; } });
        } catch {
            if ((controller.signal.aborted || !isCurrent(captured)) && !issued) return unavailable();
            return transportFailure();
        }
        if (controller.signal.aborted || !isCurrent(captured)) {
            return effect === 'write' && issued ? outcomeUnknown() : unavailable();
        }
        if (response.status === 404 || response.status === 405 || response.status === 501) {
            return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
        }

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return effect === 'write' && response.ok ? outcomeUnknown() : invalidResponse();
        }
        if (controller.signal.aborted || !isCurrent(captured)) {
            return effect === 'write' && issued ? outcomeUnknown() : unavailable();
        }
        if (!response.ok) {
            const parsedError = AccountApiTokensServerErrorV1Schema.safeParse(body);
            if (!parsedError.success) return invalidResponse();
            return {
                ok: false,
                errorCode: parsedError.data.error,
                error: parsedError.data.error,
            };
        }
        const parsed = outputSchema.safeParse(body);
        if (controller.signal.aborted || !isCurrent(captured)) {
            return effect === 'write' && issued ? outcomeUnknown() : unavailable();
        }
        if (!parsed.success) return effect === 'write' ? outcomeUnknown() : invalidResponse();
        return parsed.data;
    } catch {
        if ((controller.signal.aborted || !isCurrent(captured)) && !issued) return unavailable();
        return transportFailure();
    } finally {
        await authority?.release?.();
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
): Promise<CurrentAccountApiTokensResult<AccountApiTokensCreateActionOutputV1>> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        input,
        AccountApiTokensCreateActionInputV1Schema,
        AccountApiTokensCreateActionOutputV1Schema,
        options,
        'write',
    );
}

export async function listCurrentAccountApiTokens(
    input: AccountApiTokensListActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<CurrentAccountApiTokensResult<AccountApiTokensListActionOutputV1>> {
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
): Promise<CurrentAccountApiTokensResult<AccountApiTokensRevokeActionOutputV1>> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        input,
        AccountApiTokensRevokeActionInputV1Schema,
        AccountApiTokensRevokeActionOutputV1Schema,
        options,
        'write',
    );
}

export async function revokeAllCurrentAccountApiTokens(
    input: AccountApiTokensRevokeAllActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<CurrentAccountApiTokensResult<AccountApiTokensRevokeAllActionOutputV1>> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        input,
        AccountApiTokensRevokeAllActionInputV1Schema,
        AccountApiTokensRevokeAllActionOutputV1Schema,
        options,
        'write',
    );
}

export async function updateCurrentAccountApiToken(
    input: AccountApiTokensUpdateActionInputV1,
    options?: CurrentAccountApiTokensOptionsV1,
): Promise<CurrentAccountApiTokensResult<AccountApiTokensUpdateActionOutputV1>> {
    return await requestCurrentAccountApiTokens(
        ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
        input,
        AccountApiTokensUpdateActionInputV1Schema,
        AccountApiTokensUpdateActionOutputV1Schema,
        options,
        'write',
    );
}
