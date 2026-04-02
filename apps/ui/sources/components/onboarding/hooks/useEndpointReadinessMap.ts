import * as React from 'react';

import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { createEndpointReadinessProbe } from '@/sync/runtime/connectivity/createEndpointReadinessProbe';

export type EndpointReadinessState = Readonly<{
    status: 'unknown' | 'checking' | 'ready' | 'unavailable' | 'blocked';
    probeResult?: ReadinessProbeResult;
}>;

function isMixedContentBlockedProbeResult(result: ReadinessProbeResult): boolean {
    if (result.status !== 'retry_later') return false;
    const message = typeof result.errorMessage === 'string' ? result.errorMessage : '';
    if (!message) return false;
    return message.toLowerCase().includes('mixed content');
}

export function useEndpointReadinessMap(params: Readonly<{
    endpoints: readonly string[];
    enabled: boolean;
    timeoutMs?: number;
}>): Readonly<{
    readinessByEndpoint: ReadonlyMap<string, EndpointReadinessState>;
    retryEndpoint: (endpoint: string) => void;
}> {
    const [readinessByEndpoint, setReadinessByEndpoint] = React.useState<ReadonlyMap<string, EndpointReadinessState>>(
        () => new Map(),
    );
    const inFlightByEndpointRef = React.useRef(new Map<string, AbortController>());
    const readinessByEndpointRef = React.useRef<ReadonlyMap<string, EndpointReadinessState>>(readinessByEndpoint);

    const stableEndpointsKey = React.useMemo(() => {
        const deduped = new Set<string>();
        for (const endpoint of params.endpoints) {
            const trimmed = String(endpoint ?? '').trim();
            if (!trimmed) continue;
            deduped.add(trimmed);
        }
        return Array.from(deduped.values()).join('\n');
    }, [params.endpoints]);

    const stableEndpoints = React.useMemo(() => {
        if (!stableEndpointsKey) return [];
        return stableEndpointsKey.split('\n').filter(Boolean);
    }, [stableEndpointsKey]);

    const updateEndpointState = React.useCallback((endpoint: string, next: EndpointReadinessState) => {
        setReadinessByEndpoint((prev) => {
            const map = new Map(prev);
            map.set(endpoint, next);
            return map;
        });
    }, []);

    React.useEffect(() => {
        readinessByEndpointRef.current = readinessByEndpoint;
    }, [readinessByEndpoint]);

    const runProbe = React.useCallback(async (endpoint: string) => {
        if (!params.enabled) return;

        const existing = inFlightByEndpointRef.current.get(endpoint);
        if (existing) {
            existing.abort();
            inFlightByEndpointRef.current.delete(endpoint);
        }

        const controller = new AbortController();
        inFlightByEndpointRef.current.set(endpoint, controller);
        updateEndpointState(endpoint, { status: 'checking' });

        try {
            const probe = createEndpointReadinessProbe({
                endpoint,
                token: null,
                timeoutMs: params.timeoutMs,
                signal: controller.signal,
            });
            const result = await probe();
            const normalized: EndpointReadinessState =
                result.status === 'ready'
                    ? { status: 'ready', probeResult: result }
                    : result.status === 'retry_later'
                        ? isMixedContentBlockedProbeResult(result)
                            ? { status: 'blocked', probeResult: result }
                            : { status: 'unknown', probeResult: result }
                        : { status: 'unavailable', probeResult: result };
            if (inFlightByEndpointRef.current.get(endpoint) === controller) {
                updateEndpointState(endpoint, normalized);
            }
        } catch (error) {
            if (inFlightByEndpointRef.current.get(endpoint) === controller) {
                updateEndpointState(endpoint, {
                    status: 'unavailable',
                    probeResult: {
                        status: 'server_unreachable',
                        errorMessage: error instanceof Error ? error.message : String(error),
                    },
                });
            }
        } finally {
            if (inFlightByEndpointRef.current.get(endpoint) === controller) {
                inFlightByEndpointRef.current.delete(endpoint);
            }
        }
    }, [params.enabled, params.timeoutMs, updateEndpointState]);

    React.useEffect(() => {
        if (!params.enabled) return;
        stableEndpoints.forEach((endpoint) => {
            const existing = readinessByEndpointRef.current.get(endpoint);
            if (!existing) {
                void runProbe(endpoint);
            }
        });
        return () => {
            inFlightByEndpointRef.current.forEach((controller) => controller.abort());
            inFlightByEndpointRef.current.clear();
        };
    }, [params.enabled, runProbe, stableEndpointsKey]);

    const retryEndpoint = React.useCallback((endpoint: string) => {
        void runProbe(String(endpoint ?? '').trim());
    }, [runProbe]);

    return {
        readinessByEndpoint,
        retryEndpoint,
    };
}
