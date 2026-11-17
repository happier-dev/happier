import type { DatabaseCaptureLogCorrelationV1 } from '@happier-dev/database-protocol';
import type { createCaptureStore, CaptureListInput, CaptureSummary, CaptureEndpointListInput, CaptureEndpointSummary as StoredEndpointSummary } from './store/capture.js';
import { analyzeRequestQueries, type DatabaseExecutionEvidence, type RequestSpanEvidence } from './analysis/requests.js';
export type { CaptureEndpointCursor } from './store/capture.js';
export type CaptureEndpointSummary = StoredEndpointSummary & Readonly<{ errorRate: number | null }>;

/** A ratio over the observed request window, not a whole-service failure estimate. */
export function observedEndpointErrorRate(input: Pick<StoredEndpointSummary, 'requestCount' | 'errorCount'>): number | null {
    return input.requestCount === 0 ? null : input.errorCount / input.requestCount;
}

function evidence(summaries: readonly CaptureSummary[]): { spans: RequestSpanEvidence[]; queries: DatabaseExecutionEvidence[] } {
    const spans: RequestSpanEvidence[] = [];
    const queries: DatabaseExecutionEvidence[] = [];
    for (const summary of summaries) {
        if (summary.traceId && summary.spanId && summary.spanKind !== null && summary.spanKind !== undefined) spans.push({
            traceId: summary.traceId, spanId: summary.spanId, kind: summary.spanKind,
            ...(summary.parentSpanId ? { parentSpanId: summary.parentSpanId } : {}),
        });
        if (summary.kind === 'query' && summary.source !== 'capture') queries.push({ observationId: summary.id, source: summary.source,
            traceId: summary.traceId ?? undefined, spanId: summary.spanId ?? undefined,
            parentSpanId: summary.parentSpanId ?? undefined, executionIdentity: summary.executionIdentity ?? undefined,
            retryOf: summary.retryOf ?? undefined, shape: summary.shape ?? null, statementKind: summary.statementKind ?? 'unknown',
            parameterIdentity: summary.parameterIdentity ?? undefined, durationMs: summary.durationMs ?? 0, callsite: summary.callsite ?? undefined,
        });
    }
    return { spans, queries };
}

export function createCaptureReader(store: ReturnType<typeof createCaptureStore>) {
    async function pages(input: Omit<CaptureListInput, 'limit' | 'before'>, pageSize: number): Promise<CaptureSummary[]> {
        const result: CaptureSummary[] = [];
        let before: CaptureListInput['before'];
        while (true) {
            const page = await store.list({ ...input, limit: pageSize, before });
            result.push(...page);
            const last = page.at(-1);
            if (!last || page.length < pageSize) return result;
            before = { at: last.at, id: last.id };
        }
    }
    return {
        requests(input: Omit<CaptureListInput, 'kind' | 'spanKind'>): Promise<readonly CaptureSummary[]> {
            return store.list({ ...input, kind: 'span', spanKind: 2 });
        },
        async trace(input: { worktree: string; traceId: string; pageSize: number }) {
            const summaries = await pages({ worktree: input.worktree, traceId: input.traceId }, input.pageSize);
            const { spans, queries } = evidence(summaries);
            const spanObservations = new Map<string, string>();
            const slowChildSpans: CaptureSummary[] = [];
            for (const summary of summaries) {
                if (summary.source !== 'otlp' || (summary.kind !== 'span' && summary.kind !== 'query') || !summary.spanId) continue;
                spanObservations.set(summary.spanId, summary.id);
                // Missing parents can reflect sampled/incomplete telemetry; retain those observed children.
                if (summary.parentSpanId && summary.durationMs !== null && summary.durationMs !== undefined) slowChildSpans.push(summary);
            }
            // Child durations can overlap. Ordering exposes individual slow spans without summing wall time.
            slowChildSpans.sort((left, right) => right.durationMs! - left.durationMs! || left.id.localeCompare(right.id));
            const logCorrelations: DatabaseCaptureLogCorrelationV1[] = summaries.filter(summary => summary.kind === 'log').map(log => ({
                logId: log.id, traceId: input.traceId, spanId: log.spanId ?? null,
                spanObservationId: log.spanId ? spanObservations.get(log.spanId) ?? null : null,
            }));
            return { worktree: input.worktree, traceId: input.traceId, summaries, repeatedQueries: analyzeRequestQueries(spans, queries),
                slowChildSpans, logCorrelations };
        },
        async endpoints(input: CaptureEndpointListInput & { pageSize: number }): Promise<readonly CaptureEndpointSummary[]> {
            return (await store.endpoints(input)).map(endpoint => ({ ...endpoint, errorRate: observedEndpointErrorRate(endpoint) }));
        },
        detail: store.detail,
    };
}
