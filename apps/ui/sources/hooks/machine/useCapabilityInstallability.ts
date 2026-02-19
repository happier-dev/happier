import * as React from 'react';

import { machineCapabilitiesInvoke } from '@/sync/ops';
import type { CapabilitiesInvokeRequest } from '@/sync/ops';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { AsyncTtlCache } from '@happier-dev/protocol';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type CapabilityInstallability =
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'installable' }>
    | Readonly<{ kind: 'not-installable'; code?: string; message?: string }>
    | Readonly<{ kind: 'error'; code?: string; message?: string }>;

const NOT_INSTALLABLE_ERROR_CODES = new Set<string>([
    'install-not-available',
    'unsupported-method',
    'unsupported-platform',
]);

const TTL_INSTALLABILITY_OK_MS = 10 * 60_000;
const TTL_INSTALLABILITY_ERROR_MS = 10_000;

const cache = new AsyncTtlCache<CapabilityInstallability>({
    successTtlMs: TTL_INSTALLABILITY_OK_MS,
    errorTtlMs: TTL_INSTALLABILITY_ERROR_MS,
});

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function buildCacheKey(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    capabilityId: CapabilityId;
    timeoutMs?: number;
}>): string {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId) || 'active';
    const capabilityId = normalizeId(params.capabilityId);
    const timeoutMs = typeof params.timeoutMs === 'number' ? String(params.timeoutMs) : '';
    return `${serverId}::${machineId}:${capabilityId}:${timeoutMs}`;
}

function getTtlMsForResult(result: CapabilityInstallability): number {
    if (result.kind === 'installable' || result.kind === 'not-installable') return TTL_INSTALLABILITY_OK_MS;
    if (result.kind === 'error') return TTL_INSTALLABILITY_ERROR_MS;
    return TTL_INSTALLABILITY_ERROR_MS;
}

export function resetCapabilityInstallabilityCacheForTests(): void {
    cache.clear();
}

export function useCapabilityInstallability(params: Readonly<{
    machineId: string | null;
    serverId?: string | null;
    capabilityId: CapabilityId;
    timeoutMs?: number;
}>): CapabilityInstallability {
    const [state, setState] = React.useState<CapabilityInstallability>({ kind: 'unknown' });

    React.useEffect(() => {
        if (!params.machineId) {
            setState({ kind: 'unknown' });
            return;
        }

        const cacheKey = buildCacheKey({
            machineId: params.machineId,
            serverId: params.serverId,
            capabilityId: params.capabilityId,
            timeoutMs: params.timeoutMs,
        });
        const cached = cache.get(cacheKey);
        if (cached?.kind === 'success' && cache.isFresh(cached)) {
            setState(cached.value);
            return;
        }

        let cancelled = false;
        setState({ kind: 'checking' });

        const request: CapabilitiesInvokeRequest = {
            id: params.capabilityId,
            method: 'install',
            params: { dryRun: true, skipIfInstalled: true },
        };

        const run = async (): Promise<CapabilityInstallability> => {
            const invoke = await machineCapabilitiesInvoke(params.machineId!, request, {
                timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : 30_000,
                serverId: params.serverId,
            });

            if (!invoke.supported) {
                return invoke.reason === 'not-supported'
                    ? { kind: 'not-installable', code: invoke.reason }
                    : { kind: 'error' };
            }

            if (invoke.response.ok) {
                return { kind: 'installable' };
            }

            const code = invoke.response.error.code;
            if (typeof code === 'string' && NOT_INSTALLABLE_ERROR_CODES.has(code)) {
                return { kind: 'not-installable', code, message: invoke.response.error.message };
            }

            return { kind: 'error', code, message: invoke.response.error.message };
        };

        const p = cache.runDedupe(cacheKey, async () => {
            const result = await run().catch((e) => ({ kind: 'error', message: e instanceof Error ? e.message : 'Request failed.' } as const));
            cache.setSuccess(cacheKey, result, { ttlMs: getTtlMsForResult(result) });
            return result;
        });
        fireAndForget(
            p.then((result) => {
                if (cancelled) return;
                setState(result);
            }),
            {
                tag: 'useCapabilityInstallability.refresh',
                onError: (error) => {
                    if (cancelled) return;
                    setState({ kind: 'error', message: error instanceof Error ? error.message : 'Request failed.' });
                },
            },
        );

        return () => {
            cancelled = true;
        };
    }, [params.machineId, params.capabilityId, params.serverId, params.timeoutMs]);

    return state;
}
