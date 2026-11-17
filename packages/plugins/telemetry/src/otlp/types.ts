import type { IncomingMessage } from 'node:http';

export type TelemetryValue = null | boolean | number | string | TelemetryValue[] | { [key: string]: TelemetryValue };
export type OtlpSignal = 'traces' | 'logs';

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
) => NormalizedDatabaseStatement;

export interface NormalizedSpan {
    type: 'span';
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    serviceName?: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    durationMs: number;
    status: 'unset' | 'ok' | 'error';
    endpoint?: { method: string; route: string };
    httpStatusCode?: number;
    database?: NormalizedDatabaseStatement & { callsite?: string };
}

export interface NormalizedLog {
    type: 'log';
    timeUnixNano: string;
    observedTimeUnixNano: string;
    severityNumber: number;
    severityText?: string;
    body: TelemetryValue;
    traceId?: string;
    spanId?: string;
    serviceName?: string;
}

export interface NormalizedTelemetryBatch {
    signal: OtlpSignal;
    spans: readonly NormalizedSpan[];
    logs: readonly NormalizedLog[];
    rejectedRecords: number;
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
    /** The authenticated collector holds the existing writer across body read and persistence. */
    withWriter?: (operation: () => Promise<void>) => Promise<void>;
    normalizeStatement: NormalizeDatabaseStatement;
    onBatch: (batch: NormalizedTelemetryBatch, context: Context) => OtlpIngestResult | Promise<OtlpIngestResult>;
    /** P6 extends this receiver's ingress admission, without another parser or listener implementation. */
    admit?: (request: IncomingMessage, signal: OtlpSignal) => OtlpAdmission<Context> | Promise<OtlpAdmission<Context>>;
}
