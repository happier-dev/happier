import {
    ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
    AccountSessionsSignOutEverywhereActionInputV1Schema,
    AccountSessionsSignOutEverywhereServerOutputV1Schema,
    type AccountSessionsSignOutEverywhereActionInputV1,
    type AccountSessionsSignOutEverywhereActionOutputV1,
} from '@happier-dev/protocol';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

export type SignOutEverywhereOptionsV1 = Readonly<{
    /** The host Action can abandon its pending request without changing Account scope. */
    signal?: AbortSignal;
}>;

type CapturedActiveAccountSession = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>;
}>;

const UNAVAILABLE_MESSAGE = 'account_sessions_sign_out_unavailable';

function unavailable(): never {
    throw new Error(UNAVAILABLE_MESSAGE);
}

function isCurrent(captured: CapturedActiveAccountSession): boolean {
    const current = getActiveServerSnapshot();
    return captured.lifetime.isCurrent()
        && current.serverId === captured.serverSnapshot.serverId
        && current.generation === captured.serverSnapshot.generation;
}

function captureActiveAccountSession(): CapturedActiveAccountSession | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !lifetime.isCurrent()) return null;
    const serverSnapshot = getActiveServerSnapshot();
    if (serverSnapshot.serverId !== lifetime.scope.serverId) return null;
    return { lifetime, serverSnapshot };
}

async function parseServerOutput(
    response: Response,
): Promise<AccountSessionsSignOutEverywhereActionOutputV1 | null> {
    try {
        const parsed = AccountSessionsSignOutEverywhereServerOutputV1Schema.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * Uses the active scoped-session authority to invalidate only that Account's
 * signed sessions. A caller cannot select an Account, and an Account switch
 * aborts and drops this request rather than publishing a stale success.
 */
export async function signOutEverywhere(
    input: AccountSessionsSignOutEverywhereActionInputV1,
    options?: SignOutEverywhereOptionsV1,
): Promise<AccountSessionsSignOutEverywhereActionOutputV1> {
    const request = AccountSessionsSignOutEverywhereActionInputV1Schema.parse(input);
    if (options?.signal?.aborted) return unavailable();

    const captured = captureActiveAccountSession();
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
            activeRequest: (path, init) => apiSocket.request(path, init),
        });
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();

        const response = await authority.request(
            ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            },
        );
        if (controller.signal.aborted || !isCurrent(captured) || !response.ok) return unavailable();

        const output = await parseServerOutput(response);
        if (controller.signal.aborted || !isCurrent(captured) || !output) return unavailable();
        return output;
    } catch {
        return unavailable();
    } finally {
        options?.signal?.removeEventListener('abort', abort);
        retirement.dispose();
    }
}
