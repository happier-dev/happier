import { PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1, PluginAccountDataEraseActionInputV1Schema, PluginAccountDataEraseServerOutputV1Schema, type PluginAccountDataEraseActionInputV1, type PluginAccountDataEraseDataArmResultV1 } from '@happier-dev/protocol/plugins/data/accountEraseV1';
import { PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    resolveAccountStoredContentCompatibilityHeaders,
    withAccountStoredContentCompatibilityRequestDeclaration,
} from '@/sync/http/accountStoredContentCompatibility';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

export type EraseCurrentAccountPluginDataOptionsV1 = Readonly<{
    /** The caller can abandon a pending request without changing its Account scope. */
    signal?: AbortSignal;
}>;

type CapturedActiveAccountErase = Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>;
}>;

function unavailable(): PluginAccountDataEraseDataArmResultV1 {
    return { status: 'pending', reason: 'unavailable' };
}

function isCurrent(captured: CapturedActiveAccountErase): boolean {
    const current = getActiveServerSnapshot();
    return captured.lifetime.isCurrent()
        && current.serverId === captured.serverSnapshot.serverId
        && current.generation === captured.serverSnapshot.generation;
}

function captureActiveAccountErase(): CapturedActiveAccountErase | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !lifetime.isCurrent()) return null;
    const serverSnapshot = getActiveServerSnapshot();
    if (serverSnapshot.serverId !== lifetime.scope.serverId) return null;
    return { lifetime, serverSnapshot };
}

async function parseServerOutput(response: Response) {
    try {
        const parsed = PluginAccountDataEraseServerOutputV1Schema.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * Erases only the current authenticated Account's Data-owned plugin records.
 * Account authority is captured from the active scope and passed only through
 * the scoped session request authority; callers can select a plugin, never an
 * Account. Retirement prevents issuance; after issuance, content-free settlement
 * remains truthful even when the initiating Account is no longer active.
 */
export async function eraseCurrentAccountPluginData(
    input: PluginAccountDataEraseActionInputV1,
    options?: EraseCurrentAccountPluginDataOptionsV1,
): Promise<PluginAccountDataEraseDataArmResultV1> {
    const request = PluginAccountDataEraseActionInputV1Schema.parse(input);
    const captured = captureActiveAccountErase();
    if (!captured) return unavailable();

    const compatibility = resolveAccountStoredContentCompatibilityHeaders(
        { 'Content-Type': 'application/json' },
        {
            serverUrl: captured.serverSnapshot.serverUrl,
            declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        },
    );
    if (compatibility.status === 'unavailable') return unavailable();

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = captured.lifetime.onRetire(abort);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    let authority: Awaited<ReturnType<typeof captureServerRequestAuthorityForServerAccountScope>> | null = null;
    let issued = false;
    try {
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();

        authority = await captureServerRequestAuthorityForServerAccountScope({
            scope: captured.lifetime.scope,
            activeRequest: (path, init) => apiSocket.request(path, init),
        });
        if (controller.signal.aborted || !isCurrent(captured)) return unavailable();

        issued = true;
        const response = await authority.request(
            PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1,
            withAccountStoredContentCompatibilityRequestDeclaration({
                method: 'POST',
                headers: compatibility.headers,
                body: JSON.stringify(request),
                signal: controller.signal,
            }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        );
        if (response.status === 426) return unavailable();
        if (response.status >= 500) return { status: 'pending', reason: 'outcome-unknown' };
        if (response.status === 404) {
            const result = await parseServerOutput(response);
            return result?.status === 'account-not-found'
                ? { status: 'failed', reason: 'account-not-found' }
                : { status: 'failed', reason: 'invalid-response' };
        }
        if (!response.ok) return { status: 'failed', reason: 'request-rejected' };

        const result = await parseServerOutput(response);
        if (result?.status === 'erased') {
            return { status: 'completed', changed: result.changed };
        }
        if (result?.status === 'transition-cleanup-pending') {
            return { status: 'pending', reason: 'transition-cleanup' };
        }
        return { status: 'pending', reason: 'outcome-unknown' };
    } catch {
        return issued ? { status: 'pending', reason: 'outcome-unknown' } : unavailable();
    } finally {
        await authority?.release?.();
        options?.signal?.removeEventListener('abort', abort);
        retirement.dispose();
    }
}
