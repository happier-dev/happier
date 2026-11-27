import type { IncomingMessage } from 'node:http';
import type { ExceptionApplicationOrigin } from '../exceptions/contracts.js';
import type { DatabaseCaptureCostMetadataV1 } from '@happier-dev/database-protocol';

export type TelemetryValue = null | boolean | number | string | TelemetryValue[] | { [key: string]: TelemetryValue };
export type OtlpSignal = 'traces' | 'logs' | 'metrics';

export type ObservedDatabaseEndpoint = Readonly<{
    engine: string;
    hostname: string;
    port: number;
    database: string;
}>;

/** SQL language policy and redaction belong to the shared dialect, supplied by the runner. */
export interface NormalizedDatabaseStatement {
    shape: string | null;
    fingerprint: string | null;
    statementKind: 'select' | 'control' | 'other' | 'unknown';
    maskedSql: string | null;
    maskedParameters?: TelemetryValue;
    /** Non-secret equality token from the dialect; omitted when parameter distinction is unknown. */
    parameterIdentity?: string;
}

export type NormalizeDatabaseStatement = (
    sql: string,
    parameters: Readonly<Record<string, TelemetryValue>>,
    observeBlockComment?: (comment: string) => void,
) => NormalizedDatabaseStatement;

export interface NormalizedResourceIdentity {
    serviceName?: string;
    serviceVersion?: string;
    /** Current semantic convention, falling back to the legacy attribute when absent. */
    deploymentEnvironmentName?: string;
    deploymentEnvironment?: string;
}

/**
 * One OTel exception record (span event `exception` or log `exception.*`
 * attributes). Text fields have already passed the shared secret redactor.
 */
export interface NormalizedException {
    timeUnixNano: string;
    /** Derived only from the OTLP instrumentation scope, never app text. */
    applicationOrigin?: ExceptionApplicationOrigin;
    type?: string;
    message?: string;
    stacktrace?: string;
    /** Exporter-supplied exception.source_context text for the top in-app frame; never fetched or synthesized. */
    sourceContext?: string;
    /** `exception.escaped`, only when the emitter supplied it. */
    escaped?: boolean;
    /** Instrumentation-supplied grouping key; it wins over derived grouping. */
    fingerprint?: string;
}

export interface NormalizedSpan extends NormalizedResourceIdentity {
    type: 'span';
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    durationMs: number;
    status: 'unset' | 'ok' | 'error';
    endpoint?: { method: string; route: string };
    httpStatusCode?: number;
    database?: NormalizedDatabaseStatement & {
        callsite?: string;
        executionIdentity?: string;
        endpoint?: ObservedDatabaseEndpoint;
    };
    /** Exception events keyed by their position in the span's event list. */
    exceptions?: readonly (NormalizedException & { eventIndex: number })[];
    /** Selected numeric usage only; never prompt, completion or tool-call content. */
    genAi?: DatabaseCaptureCostMetadataV1;
}

export interface NormalizedLog extends NormalizedResourceIdentity {
    type: 'log';
    timeUnixNano: string;
    observedTimeUnixNano: string;
    severityNumber: number;
    severityText?: string;
    body: TelemetryValue;
    traceId?: string;
    spanId?: string;
    /** `log.record.uid` when the emitter supplied one; the exporter-retry identity. */
    recordUid?: string;
    exception?: NormalizedException;
}

export type MetricTemporality = 'unspecified' | 'delta' | 'cumulative';
export type MetricDimensions = Readonly<Record<string, string | number | boolean>>;
interface MetricPointIdentity extends NormalizedResourceIdentity {
    name: string;
    unit: string;
    scopeName?: string;
    scopeVersion?: string;
    resourceSchemaUrl?: string;
    scopeSchemaUrl?: string;
    serviceName?: string;
    serviceVersion?: string;
    serviceInstanceId?: string;
    /** Opaque emitter identity; unselected attribute names and values are never retained. */
    streamIdentity?: string;
    startTimeUnixNano: string;
    timeUnixNano: string;
    dimensions: MetricDimensions;
    temporality: MetricTemporality;
    /** OTLP NO_RECORDED_VALUE is preserved; it must never become a measured zero. */
    noRecordedValue?: true;
    /** Store-read fact: the retained rows do not supply a complete bucket distribution. */
    incompleteBuckets?: true;
}
export type NormalizedMetricPoint = MetricPointIdentity & (
    | Readonly<{ metricType: 'gauge'; value: number | string }>
    | Readonly<{ metricType: 'sum'; value: number | string; isMonotonic: boolean }>
    | Readonly<{ metricType: 'histogram'; count: string; bucketCounts: readonly string[]; explicitBounds: readonly number[]; sum?: number; min?: number; max?: number }>
);

export interface NormalizedTelemetryBatch {
    signal: OtlpSignal;
    spans: readonly NormalizedSpan[];
    logs: readonly NormalizedLog[];
    metrics?: readonly NormalizedMetricPoint[];
    rejectedRecords: number;
    rejectionMessage?: string;
}

export type OtlpAdmission<Context> =
    | { accepted: true; context: Context }
    | { accepted: false; status: 401 | 403 | 404 | 429 | 503; message: string };

export type OtlpIngestResult =
    | { accepted: true; rejectedRecords?: number; message?: string }
    | { accepted: false; retryable: boolean; message: string; status?: 507 };

export interface OtlpReceiverOptions<Context> {
    context: Context;
    /** OTLP/HTTP 1.11.1 requires raw and decompressed body bounds. The ingress owner may override its 64 MiB default. */
    maximumRequestBytes?: number;
    /** Capture holds the existing writer across body read and persistence. */
    withWriter?: (operation: () => Promise<void>) => Promise<void>;
    normalizeStatement: NormalizeDatabaseStatement;
    onBatch: (batch: NormalizedTelemetryBatch, context: Context) => OtlpIngestResult | Promise<OtlpIngestResult>;
    /** P6 extends this receiver's ingress admission, without another parser or listener implementation. */
    admit?: (request: IncomingMessage, signal: OtlpSignal) => OtlpAdmission<Context> | Promise<OtlpAdmission<Context>>;
}
