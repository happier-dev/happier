import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import {
    DATABASE_CAPTURE_RESOURCE_REF_V1,
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
    type DatabaseCaptureCoverageV1,
    type DatabaseCaptureSourceV1,
    type DatabaseCaptureTraceGetResultV1,
} from '@happier-dev/database-protocol';
import type { DatabaseFindingObservationV1 } from '@happier-dev/plugin-sdk/database';
import type { CaptureSummary } from '../store/capture.js';
import type { RepeatedQueryEvidence } from './requests.js';
import { captureSummaryFailed } from './requestFailure.js';

export const captureFindingSource = { pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: 'capture-findings' } as const;

export type CaptureFindingSelection = Readonly<{
    source: DatabaseCaptureSourceV1;
    sourceScope: DatabaseFindingObservationV1['sourceScope'];
    pageSize: number;
    coverage: DatabaseCaptureCoverageV1;
}>;

type CaptureFindingDetail = NonNullable<Extract<DatabaseCaptureTraceGetResultV1, { ok: true }>['findings']>[number];
type CaptureFinding = Omit<CaptureFindingDetail, 'kind' | 'exercise'> & Readonly<{
    kind: RepeatedQueryEvidence['kind'] | 'failing_endpoint';
    exercise: string;
}>;

const repeatTitles: Record<RepeatedQueryEvidence['kind'], string> = {
    suspected_n_plus_one: 'Suspected N+1 queries',
    repeated_query: 'Repeated database queries',
    duplicate_work: 'Duplicate database work',
};

/** Interpret the selected retained summaries. The capture reader already owns
 * correlation and repetition counts. Free-form exporter strings stay in Capture. */
export function projectCaptureFindings(selection: CaptureFindingSelection, summaries: readonly CaptureSummary[],
    repetitions: readonly RepeatedQueryEvidence[]): readonly CaptureFinding[] {
    const requestKey = (traceId: string, spanId: string) => JSON.stringify([traceId, spanId]);
    const requests = new Map<string, CaptureSummary & { traceId: string }>();
    for (const row of summaries) {
        if (row.kind === 'span' && row.spanKind === 2 && row.traceId && row.spanId) {
            requests.set(requestKey(row.traceId, row.spanId), { ...row, traceId: row.traceId });
        }
    }
    const { source, sourceScope, pageSize, coverage } = selection;
    const page = { limit: pageSize };
    function finding(request: Pick<CaptureSummary & { traceId: string }, 'traceId' | 'at' | 'durationMs' | 'id' | 'httpStatusCode'>,
        detail: Pick<CaptureFinding, 'kind' | 'title' | 'summary' | 'normalizedShape'>,
        members: readonly string[]): CaptureFinding {
        const { traceId } = request;
        const observedWindow = { fromMs: request.at, toMs: request.at + Math.ceil(request.durationMs ?? 0) };
        return {
            v: 1, sourceRef: captureFindingSource, sourceScope,
            evidenceIdentity: computeCanonicalDomainSeparatedDigest('happier.database.capture-finding.v1', [
                createCanonicalJsonSigningInput(source), sourceScope.machineId, traceId, request.id, detail.kind,
                detail.normalizedShape ?? '', ...[...members].sort(),
            ]),
            observedWindow,
            coverage: coverage.lostObservations > 0 ? { status: 'partial', reasons: ['partial_observation'] } : { status: 'complete' },
            ...detail,
            exercise: 'Repeat the application request shown in the captured trace and select the resulting trace in the same capture scope.',
            verification: {
                observationKey: request.id,
                ...(request.httpStatusCode == null ? {} : { httpStatusCode: request.httpStatusCode }),
                readBefore: { action: DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input: { source, traceId, page } },
                findAfter: { action: DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, input: { source, since: observedWindow.toMs, page } },
            },
        };
    }
    const findings: CaptureFinding[] = [];
    for (const repetition of repetitions) {
        const request = requests.get(requestKey(repetition.traceId, repetition.requestSpanId));
        if (!request) continue;
        findings.push(finding(request, { kind: repetition.kind, title: repeatTitles[repetition.kind],
            normalizedShape: repetition.shape, summary: { records: 1, calls: String(repetition.repetitionCount),
                totalTimeMs: repetition.totalDatabaseTimeMs } }, repetition.observationIds));
    }
    for (const request of requests.values()) {
        if (!request.endpointMethod || !request.endpointRoute || !captureSummaryFailed(request)) continue;
        findings.push(finding(request, { kind: 'failing_endpoint', title: 'Endpoint request failed',
            summary: { records: 1, ...(request.durationMs == null ? {} : { totalTimeMs: request.durationMs }) } }, []));
    }
    return findings;
}
