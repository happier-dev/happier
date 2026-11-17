export interface RequestSpanEvidence {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    kind: number;
}

export interface DatabaseExecutionEvidence {
    observationId: string;
    source: 'wire' | 'otlp';
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    /** Supplied producer identity for one execution, never shape or time. */
    executionIdentity?: string;
    retryOf?: string;
    shape: string | null;
    statementKind: 'select' | 'control' | 'other' | 'unknown';
    parameterIdentity?: string;
    durationMs: number;
    callsite?: string;
}

export interface RepeatedQueryEvidence {
    traceId: string;
    requestSpanId: string;
    shape: string;
    kind: 'suspected_n_plus_one' | 'duplicate_work' | 'repeated_query';
    repetitionCount: number;
    totalDatabaseTimeMs: number;
    observationIds: readonly string[];
    callsites: readonly string[];
    explanation: string;
}

export interface LogicalDatabaseExecution {
    evidence: DatabaseExecutionEvidence;
    observationIds: string[];
}

export interface AttributedDatabaseExecution extends LogicalDatabaseExecution {
    request: RequestSpanEvidence | undefined;
}

/** Only explicit trace/span plus execution identity can combine independent source observations. */
export function correlateDatabaseExecutions(executions: readonly DatabaseExecutionEvidence[]): readonly LogicalDatabaseExecution[] {
    const result: LogicalDatabaseExecution[] = [];
    const linked = new Map<string, LogicalDatabaseExecution>();
    for (const evidence of executions) {
        const identity = evidence.executionIdentity && evidence.traceId && evidence.spanId
            ? JSON.stringify([evidence.traceId, evidence.spanId, evidence.executionIdentity]) : undefined;
        const previous = identity ? linked.get(identity) : undefined;
        if (previous) {
            previous.observationIds.push(evidence.observationId);
            // Wire timing measures the database execution itself; application spans may include wrapper work.
            const timing = previous.evidence.source === 'wire' ? previous.evidence : evidence;
            const known = previous.evidence;
            previous.evidence = {
                ...known, ...evidence, source: timing.source, observationId: timing.observationId, durationMs: timing.durationMs,
                shape: timing.shape ?? evidence.shape ?? known.shape,
                statementKind: evidence.statementKind === 'unknown' ? known.statementKind : evidence.statementKind,
                parameterIdentity: evidence.parameterIdentity ?? known.parameterIdentity,
                callsite: evidence.callsite ?? known.callsite,
                parentSpanId: evidence.parentSpanId ?? known.parentSpanId,
                retryOf: evidence.retryOf ?? known.retryOf,
            };
        } else {
            const logical = { evidence, observationIds: [evidence.observationId] };
            result.push(logical);
            if (identity) linked.set(identity, logical);
        }
    }
    return result;
}

function requestResolver(spans: readonly RequestSpanEvidence[]) {
    const byTrace = new Map<string, Map<string, RequestSpanEvidence>>();
    for (const span of spans) {
        let trace = byTrace.get(span.traceId);
        if (!trace) { trace = new Map(); byTrace.set(span.traceId, trace); }
        trace.set(span.spanId, span);
    }
    const resolved = new Map<RequestSpanEvidence, RequestSpanEvidence | undefined>();
    return (execution: DatabaseExecutionEvidence): RequestSpanEvidence | undefined => {
        if (!execution.traceId) return undefined;
        const trace = byTrace.get(execution.traceId);
        if (!trace) return undefined;
        let current = (execution.spanId ? trace.get(execution.spanId) : undefined)
            ?? (execution.parentSpanId ? trace.get(execution.parentSpanId) : undefined);
        const path: RequestSpanEvidence[] = [];
        const seen = new Set<RequestSpanEvidence>();
        let root: RequestSpanEvidence | undefined;
        while (current && !seen.has(current)) {
            if (resolved.has(current)) { root = resolved.get(current); break; }
            seen.add(current);
            path.push(current);
            if (current.kind === 2) { root = current; break; }
            current = current.parentSpanId ? trace.get(current.parentSpanId) : undefined;
        }
        for (const item of path) resolved.set(item, root);
        return root;
    };
}

/** Shared request attribution for repeated-query evidence and endpoint database contribution. */
export function attributeDatabaseExecutions(spans: readonly RequestSpanEvidence[], executions: readonly DatabaseExecutionEvidence[]): readonly AttributedDatabaseExecution[] {
    const resolve = requestResolver(spans);
    return correlateDatabaseExecutions(executions).map(logical => ({ ...logical, request: resolve(logical.evidence) }));
}

/** SQLite boundary projection of the same attribution rules. captureEvidence is
 * summary metadata in the selected requests' traces, ordered by at DESC,id DESC
 * in the in-memory reader. Keep timing/parent precedence equivalent to that
 * order: first wire timing, otherwise last application timing, and last known
 * parent. UNION terminates ancestry cycles just as requestResolver's seen set.
 * Materialize executions once so joining spans cannot rescan their window functions.
 * The store supplies captureEvidence; this projection never reads detail bodies. */
export const REQUEST_DATABASE_TIME_SQL_CTES = `
requestSpanVersions AS (
 SELECT traceId,spanId,parentSpanId,spanKind,
 ROW_NUMBER() OVER (PARTITION BY traceId,spanId ORDER BY at,id) AS version
 FROM captureEvidence WHERE traceId IS NOT NULL AND traceId <> '' AND spanId IS NOT NULL AND spanId <> '' AND spanKind IS NOT NULL
),
requestSpans AS (SELECT traceId,spanId,parentSpanId,spanKind FROM requestSpanVersions WHERE version = 1),
executionEvidence AS (
 SELECT *,CASE WHEN traceId IS NOT NULL AND traceId <> '' AND spanId IS NOT NULL AND spanId <> '' AND executionIdentity IS NOT NULL AND executionIdentity <> '' THEN 1 ELSE 0 END AS linked
 FROM captureEvidence WHERE kind = 'query' AND source IN ('wire','otlp')
),
orderedExecutions AS (
 SELECT *,
 ROW_NUMBER() OVER (
  PARTITION BY linked,CASE WHEN linked THEN traceId ELSE id END,CASE WHEN linked THEN spanId ELSE '' END,CASE WHEN linked THEN executionIdentity ELSE '' END
  ORDER BY CASE WHEN source = 'wire' THEN 0 ELSE 1 END,CASE WHEN source = 'wire' THEN at END DESC,CASE WHEN source = 'wire' THEN id END DESC,at,id
 ) AS timingOrder,
 FIRST_VALUE(parentSpanId) OVER (
  PARTITION BY linked,CASE WHEN linked THEN traceId ELSE id END,CASE WHEN linked THEN spanId ELSE '' END,CASE WHEN linked THEN executionIdentity ELSE '' END
  ORDER BY CASE WHEN parentSpanId IS NULL THEN 1 ELSE 0 END,at,id
 ) AS knownParentSpanId
 FROM executionEvidence
),
logicalExecutions AS MATERIALIZED (
 SELECT id,traceId,spanId,knownParentSpanId,COALESCE(durationMs,0) AS durationMs FROM orderedExecutions WHERE timingOrder = 1
),
requestAncestry(executionId,durationMs,traceId,spanId,parentSpanId,spanKind) AS (
 SELECT execution.id,execution.durationMs,span.traceId,span.spanId,span.parentSpanId,span.spanKind
 FROM logicalExecutions execution JOIN requestSpans span ON span.traceId = execution.traceId AND span.spanId =
  CASE WHEN EXISTS (SELECT 1 FROM requestSpans own WHERE own.traceId = execution.traceId AND own.spanId = execution.spanId)
   THEN execution.spanId ELSE execution.knownParentSpanId END
 UNION
 SELECT ancestry.executionId,ancestry.durationMs,parent.traceId,parent.spanId,parent.parentSpanId,parent.spanKind
 FROM requestAncestry ancestry JOIN requestSpans parent ON parent.traceId = ancestry.traceId AND parent.spanId = ancestry.parentSpanId
 WHERE ancestry.spanKind <> 2
),
requestDatabaseTimes AS (
 SELECT traceId,spanId,SUM(durationMs) AS databaseTimeMs FROM requestAncestry WHERE spanKind = 2 GROUP BY traceId,spanId
)`;

export function analyzeRequestQueries(
    spans: readonly RequestSpanEvidence[],
    executions: readonly DatabaseExecutionEvidence[],
): readonly RepeatedQueryEvidence[] {
    const grouped = new Map<string, { request: RequestSpanEvidence; shape: string; executions: LogicalDatabaseExecution[] }>();
    for (const logical of attributeDatabaseExecutions(spans, executions)) {
        const execution = logical.evidence;
        if (execution.statementKind !== 'select' || !execution.shape || execution.retryOf) continue;
        const request = logical.request;
        if (!request) continue;
        const key = JSON.stringify([request.traceId, request.spanId, execution.shape]);
        let group = grouped.get(key);
        if (!group) { group = { request, shape: execution.shape, executions: [] }; grouped.set(key, group); }
        group.executions.push(logical);
    }
    const result: RepeatedQueryEvidence[] = [];
    for (const { request, shape, executions: group } of grouped.values()) {
        if (group.length < 2) continue;
        const parameterIdentities = new Set(group.map(item => item.evidence.parameterIdentity).filter(value => value !== undefined));
        const allParametersKnown = group.every(item => item.evidence.parameterIdentity !== undefined);
        const kind = parameterIdentities.size > 1 ? 'suspected_n_plus_one'
            : allParametersKnown ? 'duplicate_work' : 'repeated_query';
        result.push({
            traceId: request.traceId, requestSpanId: request.spanId, shape, kind,
            repetitionCount: group.length,
            totalDatabaseTimeMs: group.reduce((sum, item) => sum + item.evidence.durationMs, 0),
            observationIds: group.flatMap(item => item.observationIds),
            callsites: [...new Set(group.flatMap(item => item.evidence.callsite ? [item.evidence.callsite] : []))],
            explanation: kind === 'suspected_n_plus_one'
                ? 'Repeated SELECT shape within one request with distinct parameter evidence; ORM association behavior is unproven.'
                : kind === 'duplicate_work' ? 'Repeated SELECT shape within one request with identical parameter evidence.'
                    : 'Repeated SELECT shape within one request; parameter distinction is unavailable.',
        });
    }
    // Severity and automation admission remain with the finding owner; this is supporting evidence only.
    return result.sort((left, right) => right.repetitionCount - left.repetitionCount
        || right.totalDatabaseTimeMs - left.totalDatabaseTimeMs);
}
