import { ServerFetchWriteTimeoutError } from '@/sync/http/client';

export type PendingQueueRequest = (path: string, init?: RequestInit) => Promise<Response>;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Pending writes have durable identities and an outbox-owned retry lifecycle,
 * so this owner can safely bound a stalled attempt. Generic writes cannot make
 * that guarantee and intentionally remain unbounded unless their caller opts in.
 */
const ownedRequests = new WeakMap<PendingQueueRequest, { writeTimeoutMs: number; request: PendingQueueRequest }>();

export function createPendingQueueRequest(params: Readonly<{
    request: PendingQueueRequest;
    writeTimeoutMs: number;
}>): PendingQueueRequest {
    const existing = ownedRequests.get(params.request);
    if (existing?.writeTimeoutMs === params.writeTimeoutMs) return existing.request;
    const request: PendingQueueRequest = async (path, init) => {
        const method = String(init?.method ?? 'GET').toUpperCase();
        const timeoutMs = Math.max(0, Math.trunc(params.writeTimeoutMs));
        if (!MUTATING_METHODS.has(method) || timeoutMs === 0) {
            return await params.request(path, init);
        }

        const controller = new AbortController();
        const upstreamSignal = init?.signal;
        const abortFromUpstream = () => controller.abort(
            (upstreamSignal as (AbortSignal & { reason?: unknown }) | undefined)?.reason,
        );
        if (upstreamSignal?.aborted) abortFromUpstream();
        else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });

        let didTimeout = false;
        const timer = setTimeout(() => {
            didTimeout = true;
            controller.abort('pending-outbox-write-timeout');
        }, timeoutMs);

        try {
            return await params.request(path, { ...init, signal: controller.signal });
        } catch (error) {
            if (didTimeout) throw new ServerFetchWriteTimeoutError();
            throw error;
        } finally {
            clearTimeout(timer);
            upstreamSignal?.removeEventListener('abort', abortFromUpstream);
        }
    };
    ownedRequests.set(params.request, { writeTimeoutMs: params.writeTimeoutMs, request });
    return request;
}
