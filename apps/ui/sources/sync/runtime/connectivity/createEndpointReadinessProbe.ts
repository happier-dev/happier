import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { Platform } from 'react-native';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { buildRetryLaterProbeResultFromResponse } from './retryLaterProbeResult';
import { sanitizeEndpointErrorMessage } from './sanitizeEndpointErrorMessage';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';

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

function joinBaseAndPath(baseUrl: string, path: string): string {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
    const upstreamSignal = init.signal;
    let removeListener = () => {};
    if (upstreamSignal) {
        if (upstreamSignal.aborted) {
            controller.abort();
        } else {
            const onAbort = () => controller.abort();
            upstreamSignal.addEventListener('abort', onAbort, { once: true });
            removeListener = () => upstreamSignal.removeEventListener('abort', onAbort);
        }
    }
    try {
        return await runtimeFetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
        removeListener();
    }
}

export function createEndpointReadinessProbe(params: Readonly<{
    endpoint: string;
    token: string | null | (() => string | null) | (() => Promise<string | null>);
    timeoutMs?: number;
    signal?: AbortSignal;
}>): () => Promise<ReadinessProbeResult> {
    const endpoint = normalizeAbsoluteHttpBaseUrl(params.endpoint);
    const timeoutMs = params.timeoutMs ?? 800;
    const backgroundRetryAfterMs = 60_000;
    const readinessProbePaths = ['/health'];
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
        if (!isRuntimeActive()) {
            return {
                status: 'retry_later',
                retryAfterMs: backgroundRetryAfterMs,
                errorMessage: 'Runtime is inactive',
            };
        }
        if (!endpoint) {
            return {
                status: 'server_unreachable',
                errorMessage: 'Invalid endpoint URL',
            };
        }
        if (isWebMixedContentBlocked(endpoint)) {
            return {
                status: 'retry_later',
                retryAfterMs: backgroundRetryAfterMs,
                errorMessage: 'Browser blocked mixed content (HTTPS app cannot reach HTTP endpoint)',
            };
        }
        let readinessError: string | null = null;
        let readinessOk = false;
        for (const path of readinessProbePaths) {
            try {
                const response = await fetchWithTimeout(
                    joinBaseAndPath(endpoint, path),
                    {
                        method: 'GET',
                        headers: { Accept: 'application/json' },
                        ...(params.signal ? { signal: params.signal } : {}),
                    },
                    timeoutMs,
                );

                if (response.status === 429) {
                    return buildRetryLaterProbeResultFromResponse(response, `Readiness probe returned ${response.status}`);
                }

                if (response.status === 503 || response.status >= 500) {
                    return buildRetryLaterProbeResultFromResponse(response, `Readiness probe returned ${response.status}`);
                }

                if (response.ok) {
                    readinessOk = true;
                    break;
                }

                if (response.status === 401 || response.status === 403) {
                    readinessOk = true;
                    break;
                }

                if (response.status === 404) {
                    readinessError ??= `Readiness probe returned ${response.status}`;
                    continue;
                }

                readinessError ??= `Readiness probe returned ${response.status}`;
            } catch (error) {
                readinessError = sanitizeEndpointErrorMessage(error) ?? readinessError ?? 'Network request failed';
            }
        }

        if (!readinessOk) {
            return {
                status: 'server_unreachable',
                errorMessage: readinessError ?? 'Network request failed',
            };
        }

        const token = await resolveToken();
        if (!token) {
            return { status: 'ready' };
        }

        try {
            const authResponse = await fetchWithTimeout(
                joinBaseAndPath(endpoint, '/v1/auth/ping'),
                {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    ...(params.signal ? { signal: params.signal } : {}),
                },
                timeoutMs,
            );

            if (authResponse.status === 401 || authResponse.status === 403) {
                return {
                    status: 'auth_failed',
                    statusCode: authResponse.status,
                    errorMessage: `Authenticated probe returned ${authResponse.status}`,
                };
            }

            if (authResponse.status === 429) {
                return buildRetryLaterProbeResultFromResponse(authResponse, `Authenticated probe returned ${authResponse.status}`);
            }

            if (authResponse.status >= 500) {
                return buildRetryLaterProbeResultFromResponse(authResponse, `Authenticated probe returned ${authResponse.status}`);
            }

            if (authResponse.status !== 200) {
                return {
                    status: 'server_unreachable',
                    errorMessage: `Authenticated probe returned ${authResponse.status}`,
                };
            }

            return { status: 'ready' };
        } catch (error) {
            return {
                status: 'server_unreachable',
                errorMessage: sanitizeEndpointErrorMessage(error) ?? 'Network request failed',
            };
        }
    };
}
