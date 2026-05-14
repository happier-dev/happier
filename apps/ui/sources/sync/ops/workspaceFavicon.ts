import {
    WorkspaceFaviconResolveRequestV1Schema,
    WorkspaceFaviconResolveResponseV1Schema,
    type WorkspaceFaviconResolveRequestV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type WorkspaceFaviconResult =
    | Readonly<{ status: 'disabled' }>
    | Readonly<{ status: 'missing' }>
    | Readonly<{ status: 'found'; uri: string; relativePath: string }>;

export type ResolveWorkspaceFaviconInput = Readonly<{
    machineId: string;
    workspacePath: string;
    serverId?: string | null;
    enabled?: boolean;
    timeoutMs?: number | null;
}>;

const faviconCache = new Map<string, Promise<WorkspaceFaviconResult>>();

export function clearWorkspaceFaviconCacheForTests(): void {
    faviconCache.clear();
}

export function resolveWorkspaceFavicon(input: ResolveWorkspaceFaviconInput): Promise<WorkspaceFaviconResult> {
    if (input.enabled === false) return Promise.resolve({ status: 'disabled' });
    const cacheKey = buildWorkspaceFaviconCacheKey(input);
    const cached = faviconCache.get(cacheKey);
    if (cached) return cached;

    const promise = resolveWorkspaceFaviconUncached(input).catch((error) => {
        faviconCache.delete(cacheKey);
        throw error;
    });
    faviconCache.set(cacheKey, promise);
    return promise;
}

async function resolveWorkspaceFaviconUncached(input: ResolveWorkspaceFaviconInput): Promise<WorkspaceFaviconResult> {
    const payload = WorkspaceFaviconResolveRequestV1Schema.parse({
        workspacePath: input.workspacePath,
    } satisfies WorkspaceFaviconResolveRequestV1);

    const response = await machineRpcWithServerScope<unknown, WorkspaceFaviconResolveRequestV1>({
        machineId: input.machineId,
        serverId: input.serverId ?? undefined,
        timeoutMs: input.timeoutMs ?? undefined,
        method: RPC_METHODS.WORKSPACE_FAVICON_RESOLVE,
        payload,
    });

    const parsed = WorkspaceFaviconResolveResponseV1Schema.safeParse(response);
    if (!parsed.success || !parsed.data.success || !parsed.data.found) {
        return { status: 'missing' };
    }

    return {
        status: 'found',
        uri: `data:${parsed.data.mimeType};base64,${parsed.data.contentBase64}`,
        relativePath: parsed.data.relativePath,
    };
}

function buildWorkspaceFaviconCacheKey(input: ResolveWorkspaceFaviconInput): string {
    return [
        input.serverId ?? '',
        input.machineId,
        input.workspacePath,
    ].join('\0');
}
