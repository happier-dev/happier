import type { ManagedConnectionState, ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { Platform } from 'react-native';
import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { acquireServerReachabilitySupervisor, subscribeServerReachabilityState } from './serverReachabilitySupervisorPool';

/** Probe-local browser refusal detail, independent of the message shown to people. */
export type EndpointReadinessProbeResult = ReadinessProbeResult & Readonly<{
    blockedBy?: 'mixed_content';
}>;

function normalizeAbsoluteHttpBaseUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }
        if (url.username || url.password) {
            url.username = '';
            url.password = '';
        }
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function isWebMixedContentBlocked(baseUrl: string): boolean {
    if (Platform.OS !== 'web') return false;
    let endpointProtocol: string | null = null;
    try {
        endpointProtocol = new URL(baseUrl).protocol;
    } catch {
        return false;
    }
    const globalWithLocation = globalThis as unknown as { location?: { protocol?: string } };
    const pageProtocol = globalWithLocation.location?.protocol;
    return pageProtocol === 'https:' && endpointProtocol === 'http:';
}

export function readEndpointReadinessResultFromState(state: ManagedConnectionState): EndpointReadinessProbeResult | null {
    if (state.phase === 'online') return { status: 'ready' };
    const errorMessage = sanitizeEndpointErrorMessage(state.lastErrorMessage);
    const detail = errorMessage ? { errorMessage } : {};
    if (state.phase === 'auth_failed') return { status: 'auth_failed', ...detail };
    if (state.phase !== 'offline') return null;
    if (state.reason === 'probe_failed' || state.reason === 'server_restarting') {
        return {
            status: 'retry_later',
            reason: state.reason,
            ...(state.nextRetryAt === null ? {} : { retryAfterMs: Math.max(0, state.nextRetryAt - Date.now()) }),
            ...detail,
        };
    }
    return { status: 'server_unreachable', ...detail };
}

export function readEndpointReadinessBlockedResult(endpoint: string): EndpointReadinessProbeResult | null {
    const backgroundRetryAfterMs = 60_000;
    if (!isRuntimeActive()) {
        return { status: 'retry_later', retryAfterMs: backgroundRetryAfterMs, errorMessage: 'Runtime is inactive' };
    }
    const normalized = normalizeAbsoluteHttpBaseUrl(endpoint);
    if (!normalized) return { status: 'server_unreachable', errorMessage: 'Invalid endpoint URL' };
    if (isWebMixedContentBlocked(normalized)) {
        return {
            status: 'retry_later',
            retryAfterMs: backgroundRetryAfterMs,
            blockedBy: 'mixed_content',
            errorMessage: 'Browser blocked mixed content (HTTPS app cannot reach HTTP endpoint)',
        };
    }
    return null;
}

export function createEndpointReadinessProbe(params: Readonly<{
    endpoint: string;
    token: string | null | (() => string | null) | (() => Promise<string | null>);
    signal?: AbortSignal;
}>): () => Promise<EndpointReadinessProbeResult> {
    const endpoint = normalizeAbsoluteHttpBaseUrl(params.endpoint);
    const resolveToken = async (): Promise<string | null> => {
        try {
            const raw = typeof params.token === 'function' ? params.token() : params.token;
            const resolved = raw instanceof Promise ? await raw : raw;
            const value = typeof resolved === 'string' ? resolved.trim() : '';
            return value.length > 0 ? value : null;
        } catch {
            return null;
        }
    };

    return async () => {
        const blocked = readEndpointReadinessBlockedResult(params.endpoint);
        if (blocked) return blocked;
        // The guard above establishes an absolute HTTP endpoint.
        if (!endpoint) throw new Error('Invalid endpoint URL');
        return await new Promise<EndpointReadinessProbeResult>((resolve, reject) => {
            let settled = false;
            let unsubscribe = () => {};
            let release = () => {};
            const cleanup = () => {
                unsubscribe();
                release();
                params.signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
            };
            params.signal?.addEventListener('abort', onAbort, { once: true });
            if (params.signal?.aborted) {
                onAbort();
                return;
            }
            void resolveToken().then((token) => {
                if (settled) return;
                // The Home pool owns the network probe. This caller observes its
                // verdict and releases only its own demand, including on abort.
                const leasePromise = acquireServerReachabilitySupervisor({ serverUrl: endpoint, token });
                release = () => {
                    void leasePromise.then((lease) => lease.release()).catch(() => {});
                };
                const finish = (result: EndpointReadinessProbeResult) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(result);
                };
                const detach = subscribeServerReachabilityState(endpoint, (state) => {
                    const result = readEndpointReadinessResultFromState(state);
                    if (result) finish(result);
                }, token);
                unsubscribe = detach;
                if (settled) unsubscribe();
                void leasePromise.catch((error: unknown) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(error);
                });
            });
        });
    };
}
