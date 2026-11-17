import type { NormalizeDatabaseStatement, NormalizedLog, NormalizedSpan, NormalizedTelemetryBatch, OtlpSignal, TelemetryValue } from './types.js';

export class OtlpDecodeError extends Error {}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OtlpDecodeError('Expected an OTLP object');
    return value as Record<string, unknown>;
}

function list(value: unknown): readonly unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new OtlpDecodeError('Expected an OTLP array');
    return value;
}

function text(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new OtlpDecodeError('Expected an OTLP string');
    return value;
}

function integer(value: unknown, fallback = 0): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new OtlpDecodeError('Expected an OTLP unsigned integer');
    return value;
}

function nanos(value: unknown): string {
    if (value === undefined) return '0';
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new OtlpDecodeError('Expected OTLP nanoseconds');
    const parsed = BigInt(value);
    if (parsed > 18446744073709551615n) throw new OtlpDecodeError('OTLP nanoseconds exceed uint64');
    return parsed.toString();
}

function identity(value: unknown, byteLength: number, optional = false): string | undefined {
    if (optional && (value === undefined || value === '')) return undefined;
    const result = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : text(value);
    if (!result || result.length !== byteLength * 2 || !/^[\da-f]+$/i.test(result) || /^0+$/.test(result)) {
        throw new OtlpDecodeError('Invalid OTLP trace or span identity');
    }
    return result.toLowerCase();
}

function anyValue(value: unknown): TelemetryValue {
    const item = record(value);
    if (item.stringValue !== undefined) return text(item.stringValue) ?? '';
    if (item.boolValue !== undefined) {
        if (typeof item.boolValue !== 'boolean') throw new OtlpDecodeError('Invalid OTLP boolean');
        return item.boolValue;
    }
    if (item.intValue !== undefined) {
        const int = item.intValue;
        if (typeof int === 'number' && Number.isSafeInteger(int)) return String(int);
        if (typeof int !== 'string' || !/^-?\d+$/.test(int)) throw new OtlpDecodeError('Invalid OTLP int64');
        return BigInt(int).toString();
    }
    if (item.doubleValue !== undefined) {
        if (item.doubleValue === 'NaN' || item.doubleValue === 'Infinity' || item.doubleValue === '-Infinity') return item.doubleValue;
        if (typeof item.doubleValue !== 'number') throw new OtlpDecodeError('Invalid OTLP double');
        // Protobuf JSON spells these values as strings; preserve that lossless, JSON-safe form in storage.
        if (!Number.isFinite(item.doubleValue)) return String(item.doubleValue);
        return item.doubleValue;
    }
    if (item.arrayValue !== undefined) return list(record(item.arrayValue).values).map(anyValue);
    if (item.kvlistValue !== undefined) return attributes(record(item.kvlistValue).values);
    if (item.bytesValue instanceof Uint8Array) return Buffer.from(item.bytesValue).toString('base64');
    if (item.bytesValue !== undefined) return text(item.bytesValue) ?? '';
    return null;
}

function attributes(value: unknown): Record<string, TelemetryValue> {
    return Object.fromEntries(list(value).map(entry => {
        const attribute = record(entry);
        const key = text(attribute.key);
        if (key === undefined) throw new OtlpDecodeError('Missing OTLP attribute key');
        return [key, attribute.value === undefined ? null : anyValue(attribute.value)];
    }));
}

function attributeText(values: Record<string, TelemetryValue>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = values[key];
        if (typeof value === 'string') return value;
    }
    return undefined;
}

function span(value: unknown, serviceName: string | undefined, normalizeStatement: NormalizeDatabaseStatement): NormalizedSpan {
    const input = record(value);
    const traceId = identity(input.traceId, 16);
    const spanId = identity(input.spanId, 8);
    if (!traceId || !spanId) throw new OtlpDecodeError('Missing OTLP span identity');
    const parentSpanId = identity(input.parentSpanId, 8, true);
    const values = attributes(input.attributes);
    const startTimeUnixNano = nanos(input.startTimeUnixNano);
    const endTimeUnixNano = nanos(input.endTimeUnixNano);
    const duration = BigInt(endTimeUnixNano) - BigInt(startTimeUnixNano);
    if (duration < 0n) throw new OtlpDecodeError('OTLP span ends before it starts');
    const kind = integer(input.kind);
    const statusCode = input.status === undefined ? 0 : integer(record(input.status).code);
    const statement = attributeText(values, 'db.query.text', 'db.statement');
    const isDatabase = statement !== undefined || attributeText(values, 'db.system.name', 'db.system') !== undefined;
    const route = attributeText(values, 'http.route')?.trim();
    const method = attributeText(values, 'http.request.method', 'http.method')?.trim();
    const rawHttpStatus = values['http.response.status_code'] ?? values['http.status_code'];
    const httpStatusCode = typeof rawHttpStatus === 'string' && /^\d+$/.test(rawHttpStatus) ? Number(rawHttpStatus) : rawHttpStatus;
    const parameters = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('db.query.parameter.')));
    const normalized = statement === undefined ? undefined : normalizeStatement(statement, parameters);
    const callsite = attributeText(values, 'code.function.name', 'code.function');
    return {
        type: 'span', traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}),
        ...(serviceName ? { serviceName } : {}),
        // A DB span's free-form name may contain the original SQL. Only the dialect result leaves ingress.
        name: isDatabase ? normalized?.shape ?? 'database' : text(input.name) ?? '',
        kind, startTimeUnixNano, endTimeUnixNano, durationMs: Number(duration) / 1_000_000,
        status: statusCode === 2 ? 'error' : statusCode === 1 ? 'ok' : 'unset',
        ...(kind === 2 && route && method ? { endpoint: { method, route } } : {}),
        ...(typeof httpStatusCode === 'number' && Number.isSafeInteger(httpStatusCode) ? { httpStatusCode } : {}),
        ...(isDatabase ? { database: {
            ...(normalized ?? { shape: null, fingerprint: null, statementKind: 'unknown' as const, maskedSql: null }),
            ...(callsite ? { callsite } : {}),
        } } : {}),
    };
}

function log(value: unknown, serviceName: string | undefined): NormalizedLog {
    const input = record(value);
    const traceId = identity(input.traceId, 16, true);
    const spanId = identity(input.spanId, 8, true);
    const severityText = text(input.severityText);
    return {
        type: 'log', timeUnixNano: nanos(input.timeUnixNano), observedTimeUnixNano: nanos(input.observedTimeUnixNano),
        severityNumber: integer(input.severityNumber), ...(severityText ? { severityText } : {}),
        body: input.body === undefined ? null : anyValue(input.body),
        ...(traceId ? { traceId } : {}), ...(spanId ? { spanId } : {}), ...(serviceName ? { serviceName } : {}),
    };
}

export function normalizeOtlpEnvelope(signal: OtlpSignal, envelope: unknown, normalizeStatement: NormalizeDatabaseStatement): NormalizedTelemetryBatch {
    const input = record(envelope);
    const spans: NormalizedSpan[] = [];
    const logs: NormalizedLog[] = [];
    let rejectedRecords = 0;
    for (const resourceValue of list(input[signal === 'traces' ? 'resourceSpans' : 'resourceLogs'])) {
        const resource = record(resourceValue);
        const resourceAttributes = resource.resource === undefined ? {} : attributes(record(resource.resource).attributes);
        const serviceName = attributeText(resourceAttributes, 'service.name');
        for (const scopeValue of list(resource[signal === 'traces' ? 'scopeSpans' : 'scopeLogs'])) {
            const scope = record(scopeValue);
            for (const item of list(scope[signal === 'traces' ? 'spans' : 'logRecords'])) {
                try {
                    if (signal === 'traces') spans.push(span(item, serviceName, normalizeStatement));
                    else logs.push(log(item, serviceName));
                } catch (error) {
                    if (!(error instanceof OtlpDecodeError)) throw error;
                    rejectedRecords += 1;
                }
            }
        }
    }
    return { signal, spans, logs, rejectedRecords };
}
