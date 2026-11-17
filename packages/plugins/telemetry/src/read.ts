import type { createCaptureStore, CaptureListInput, CaptureSummary, CaptureEndpointListInput } from './store/capture.js';
import { analyzeRequestQueries, type DatabaseExecutionEvidence, type RequestSpanEvidence } from './analysis/requests.js';
export type { CaptureEndpointCursor, CaptureEndpointSummary } from './store/capture.js';

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
            return { worktree: input.worktree, traceId: input.traceId, summaries, repeatedQueries: analyzeRequestQueries(spans, queries) };
        },
        endpoints(input: CaptureEndpointListInput & { pageSize: number }) { return store.endpoints(input); },
        detail: store.detail,
    };
}
