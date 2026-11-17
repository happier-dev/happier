import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';
import { createHash } from 'node:crypto';
import { resolveUsageTokenCategories, type DatabaseCaptureCostMetadataV1 } from '@happier-dev/database-protocol';
import type { MetricDimensions, MetricTemporality, NormalizeDatabaseStatement, NormalizedException, NormalizedLog, NormalizedMetricPoint, NormalizedResourceIdentity, NormalizedSpan, NormalizedTelemetryBatch, OtlpSignal, TelemetryValue } from './types.js';

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

function anyValue(value: unknown, preserveType = false): TelemetryValue {
    const item = record(value);
    // Metric stream identity needs the wire type as well as the decoded value;
    // int64/bytes stay JSON-safe strings in the ordinary capture projection.
    const output = (type: string, decoded: TelemetryValue): TelemetryValue => preserveType ? { [type]: decoded } : decoded;
    if (item.stringValue !== undefined) return output('stringValue', text(item.stringValue) ?? '');
    if (item.boolValue !== undefined) {
        if (typeof item.boolValue !== 'boolean') throw new OtlpDecodeError('Invalid OTLP boolean');
        return output('boolValue', item.boolValue);
    }
    if (item.intValue !== undefined) {
        const int = item.intValue;
        if (typeof int === 'number' && Number.isSafeInteger(int)) return output('intValue', String(int));
        if (typeof int !== 'string' || !/^-?\d+$/.test(int)) throw new OtlpDecodeError('Invalid OTLP int64');
        return output('intValue', BigInt(int).toString());
    }
    if (item.doubleValue !== undefined) {
        if (item.doubleValue === 'NaN' || item.doubleValue === 'Infinity' || item.doubleValue === '-Infinity') return output('doubleValue', item.doubleValue);
        if (typeof item.doubleValue !== 'number') throw new OtlpDecodeError('Invalid OTLP double');
        // Protobuf JSON spells these values as strings; preserve that lossless, JSON-safe form in storage.
        if (!Number.isFinite(item.doubleValue)) return output('doubleValue', String(item.doubleValue));
        return output('doubleValue', item.doubleValue);
    }
    if (item.arrayValue !== undefined) return output('arrayValue', list(record(item.arrayValue).values).map(value => anyValue(value, preserveType)));
    if (item.kvlistValue !== undefined) return output('kvlistValue', attributes(record(item.kvlistValue).values, preserveType));
    if (item.bytesValue instanceof Uint8Array) return output('bytesValue', Buffer.from(item.bytesValue).toString('base64'));
    if (item.bytesValue !== undefined) return output('bytesValue', text(item.bytesValue) ?? '');
    return output('emptyValue', null);
}

function attributes(value: unknown, preserveType = false): Record<string, TelemetryValue> {
    return Object.fromEntries(list(value).map(entry => {
        const attribute = record(entry);
        const key = text(attribute.key);
        if (key === undefined) throw new OtlpDecodeError('Missing OTLP attribute key');
        return [key, anyValue(attribute.value === undefined ? {} : attribute.value, preserveType)];
    }));
}

function attributeText(values: Record<string, TelemetryValue>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = values[key];
        if (typeof value === 'string') return value;
    }
    return undefined;
}

/** Semconv 1.45 token names; inclusion is SHOULD, so positive cache/reasoning remains unknown. */
function genAiUsage(values: Record<string, TelemetryValue>, rawAttributes: unknown): DatabaseCaptureCostMetadataV1 | undefined {
    if (!Object.keys(values).some(key => key.startsWith('gen_ai.usage.'))) return undefined;
    // Reuse the typed OTLP decoder: an int64 is numeric, a numeric-looking string attribute is not.
    const typedValues = attributes(rawAttributes, true);
    function numeric(key: string): number | undefined {
        const value = typedValues[key];
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
        if (typeof value.intValue === 'string') return Number(value.intValue);
        return typeof value.doubleValue === 'number' ? value.doubleValue : undefined;
    }
    function counter(...keys: string[]): number | null {
        for (const key of keys) {
            if (values[key] === undefined) continue;
            const value = numeric(key);
            return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
        }
        return null;
    }
    const tokens = {
        input: counter('gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'),
        output: counter('gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'),
        cacheRead: counter('gen_ai.usage.cache_read.input_tokens'),
        cacheWrite: counter('gen_ai.usage.cache_creation.input_tokens'),
        reasoning: counter('gen_ai.usage.reasoning.output_tokens'), total: null,
    };
    // A documented Happier extension, not an OTel monetary convention. Currency is mandatory.
    const amount = numeric('gen_ai.usage.cost');
    const currency = attributeText(values, 'gen_ai.usage.cost.currency')?.trim();
    const reportedCost = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && currency
        ? { amount, currency } : null;
    if (Object.values(tokens).every(value => value === null) && !reportedCost) return undefined;
    const metadata = (...keys: string[]) => {
        const value = attributeText(values, ...keys)?.trim();
        return value ? redactBugReportSensitiveText(value) : null;
    };
    const requestedModel = metadata('gen_ai.request.model');
    return { provider: metadata('gen_ai.provider.name', 'gen_ai.system'), operation: metadata('gen_ai.operation.name'),
        requestedModel, modelId: metadata('gen_ai.response.model') ?? requestedModel, tokens,
        tokenCategories: resolveUsageTokenCategories(tokens, null), reportedCost };
}

/** The shared secret redactor runs once here, before storage, grouping or any reader. */
function redactValue(value: TelemetryValue): TelemetryValue {
    if (typeof value === 'string') return redactBugReportSensitiveText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
    return value;
}

function exceptionRecord(values: Record<string, TelemetryValue>, timeUnixNano: string, scopeName: string | undefined): NormalizedException | undefined {
    const type = attributeText(values, 'exception.type');
    const message = attributeText(values, 'exception.message');
    // OTel requires type or message on an exception record.
    if (type === undefined && message === undefined) return undefined;
    const stacktrace = attributeText(values, 'exception.stacktrace');
    const escaped = values['exception.escaped'];
    const suppliedFingerprint = values['exception.fingerprint'];
    const fingerprint = typeof suppliedFingerprint === 'string' ? suppliedFingerprint
        : Array.isArray(suppliedFingerprint) && suppliedFingerprint.length > 0 && suppliedFingerprint.every(part => typeof part === 'string')
            ? JSON.stringify(suppliedFingerprint) : undefined;
    return {
        timeUnixNano,
        ...(scopeName === 'app.browser.errors' ? { applicationOrigin: 'browser' as const } : {}),
        ...(type !== undefined ? { type: redactBugReportSensitiveText(type) } : {}),
        ...(message !== undefined ? { message: redactBugReportSensitiveText(message) } : {}),
        ...(stacktrace !== undefined ? { stacktrace: redactBugReportSensitiveText(stacktrace) } : {}),
        ...(typeof escaped === 'boolean' ? { escaped } : {}),
        ...(fingerprint !== undefined ? { fingerprint: redactBugReportSensitiveText(fingerprint) } : {}),
    };
}

function spanExceptions(value: unknown, scopeName: string | undefined): NonNullable<NormalizedSpan['exceptions']> {
    const exceptions: (NormalizedException & { eventIndex: number })[] = [];
    list(value).forEach((eventValue, eventIndex) => {
        const event = record(eventValue);
        if (text(event.name) !== 'exception') return;
        const exception = exceptionRecord(attributes(event.attributes), nanos(event.timeUnixNano), scopeName);
        if (exception) exceptions.push({ ...exception, eventIndex });
    });
    return exceptions;
}

function resourceIdentity(values: Record<string, TelemetryValue>): NormalizedResourceIdentity {
    const serviceName = attributeText(values, 'service.name');
    const serviceVersion = attributeText(values, 'service.version');
    const deploymentEnvironment = attributeText(values, 'deployment.environment');
    const deploymentEnvironmentName = attributeText(values, 'deployment.environment.name') ?? deploymentEnvironment;
    return {
        ...(serviceName ? { serviceName } : {}),
        ...(serviceVersion !== undefined ? { serviceVersion } : {}),
        ...(deploymentEnvironmentName !== undefined ? { deploymentEnvironmentName } : {}),
        ...(deploymentEnvironment !== undefined ? { deploymentEnvironment } : {}),
    };
}

function span(value: unknown, resource: NormalizedResourceIdentity, normalizeStatement: NormalizeDatabaseStatement, scopeName: string | undefined): NormalizedSpan {
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
    const exceptions = spanExceptions(input.events, scopeName);
    const genAi = genAiUsage(values, input.attributes);
    return {
        type: 'span', traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}),
        ...resource,
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
        ...(exceptions.length > 0 ? { exceptions } : {}),
        ...(genAi ? { genAi } : {}),
    };
}

function log(value: unknown, resource: NormalizedResourceIdentity, scopeName: string | undefined): NormalizedLog {
    const input = record(value);
    const traceId = identity(input.traceId, 16, true);
    const spanId = identity(input.spanId, 8, true);
    const severityText = text(input.severityText);
    const values = attributes(input.attributes);
    const timeUnixNano = nanos(input.timeUnixNano);
    const observedTimeUnixNano = nanos(input.observedTimeUnixNano);
    const recordUid = attributeText(values, 'log.record.uid');
    const exception = exceptionRecord(values, timeUnixNano !== '0' ? timeUnixNano : observedTimeUnixNano, scopeName);
    return {
        type: 'log', timeUnixNano, observedTimeUnixNano,
        severityNumber: integer(input.severityNumber), ...(severityText ? { severityText } : {}),
        body: input.body === undefined ? null : redactValue(anyValue(input.body)),
        ...(traceId ? { traceId } : {}), ...(spanId ? { spanId } : {}), ...resource,
        ...(recordUid ? { recordUid } : {}), ...(exception ? { exception } : {}),
    };
}

/** Canonical opaque identity: retain emitter stream distinctions without raw arbitrary attributes. */
function metricAttributeIdentity(value: TelemetryValue): string {
    const canonical = (item: TelemetryValue): TelemetryValue => Array.isArray(item) ? item.map(canonical)
        : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
/** Only semantic dimensions used by route/runtime views leave the ingress boundary. */
function metricDimensions(values: Record<string, TelemetryValue>): MetricDimensions {
    const selected: Record<string, string | number | boolean> = {};
    for (const key of ['http.route', 'http.request.method', 'http.response.status_code', 'http.method', 'http.status_code',
        'v8js.gc.type', 'v8js.heap.space.name', 'nodejs.gc.type', 'jvm.gc.name', 'jvm.gc.action',
        'jvm.memory.type', 'jvm.memory.pool.name', 'dotnet.gc.heap.generation', 'go.memory.type']) {
        const value = values[key];
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') selected[key] = value;
    }
    if (selected['http.request.method'] === undefined && selected['http.method'] !== undefined) selected['http.request.method'] = selected['http.method']!;
    if (selected['http.response.status_code'] === undefined && selected['http.status_code'] !== undefined) selected['http.response.status_code'] = selected['http.status_code']!;
    delete selected['http.method'];
    delete selected['http.status_code'];
    return selected;
}
function metricNumber(value: unknown): number {
    if (typeof value === 'string' && ['NaN', 'Infinity', '-Infinity'].includes(value)) throw new OtlpDecodeError('Non-finite metric value');
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new OtlpDecodeError('Expected a finite metric value');
    return value;
}
function metricInteger(value: unknown, signed = false): string {
    if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
    if (typeof value !== 'string' || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) throw new OtlpDecodeError('Expected a metric integer');
    const parsed = BigInt(value);
    if (parsed < (signed ? -9223372036854775808n : 0n) || parsed > (signed ? 9223372036854775807n : 18446744073709551615n)) throw new OtlpDecodeError('Metric integer exceeds OTLP range');
    return parsed.toString();
}
function metricTemporality(value: unknown): MetricTemporality {
    if (value === 1 || value === 'AGGREGATION_TEMPORALITY_DELTA') return 'delta';
    if (value === 2 || value === 'AGGREGATION_TEMPORALITY_CUMULATIVE') return 'cumulative';
    if (value === undefined || value === 0 || value === 'AGGREGATION_TEMPORALITY_UNSPECIFIED') return 'unspecified';
    throw new OtlpDecodeError('Invalid metric aggregation temporality');
}
function metricPoint(value: unknown, metadata: Omit<NormalizedMetricPoint, 'metricType' | 'value' | 'count' | 'bucketCounts' | 'explicitBounds' | 'startTimeUnixNano' | 'timeUnixNano' | 'dimensions'>,
    metricType: 'gauge' | 'sum' | 'histogram', isMonotonic: boolean): NormalizedMetricPoint {
    const point = record(value);
    const startTimeUnixNano = nanos(point.startTimeUnixNano);
    const timeUnixNano = nanos(point.timeUnixNano);
    if (timeUnixNano === '0' || BigInt(startTimeUnixNano) > BigInt(timeUnixNano)) throw new OtlpDecodeError('Invalid metric point interval');
    const noRecordedValue = (integer(point.flags) & 1) !== 0;
    const values = attributes(point.attributes);
    const base = { ...metadata, startTimeUnixNano, timeUnixNano, streamIdentity: metricAttributeIdentity([metadata.streamIdentity ?? '', attributes(point.attributes, true)]), dimensions: metricDimensions(values), ...(noRecordedValue ? { noRecordedValue: true as const } : {}) };
    if (metricType === 'histogram') {
        const count = metricInteger(point.count ?? '0');
        const bucketCounts = list(point.bucketCounts).map(value => metricInteger(value));
        const explicitBounds = list(point.explicitBounds).map(metricNumber);
        if ((bucketCounts.length > 0 && bucketCounts.length !== explicitBounds.length + 1) || (bucketCounts.length === 0 && explicitBounds.length > 0) || explicitBounds.some((bound, index) => index > 0 && bound <= explicitBounds[index - 1]!)
            || (bucketCounts.length > 0 && bucketCounts.reduce((total, value) => total + BigInt(value), 0n) !== BigInt(count))) throw new OtlpDecodeError('Invalid explicit histogram buckets');
        return { ...base, metricType, count, bucketCounts, explicitBounds,
            ...(point.sum !== undefined ? { sum: metricNumber(point.sum) } : {}),
            ...(point.min !== undefined ? { min: metricNumber(point.min) } : {}), ...(point.max !== undefined ? { max: metricNumber(point.max) } : {}) };
    }
    if (!noRecordedValue && (point.asDouble === undefined) === (point.asInt === undefined)) throw new OtlpDecodeError('Expected one metric number');
    const numeric = point.asInt !== undefined ? metricInteger(point.asInt, true) : point.asDouble !== undefined ? metricNumber(point.asDouble) : 0;
    return metricType === 'sum' ? { ...base, metricType, value: numeric, isMonotonic } : { ...base, metricType, value: numeric };
}
function normalizeMetricsEnvelope(input: Record<string, unknown>): NormalizedTelemetryBatch {
    const metrics: NormalizedMetricPoint[] = [];
    const unsupportedTypes = new Set<string>();
    let rejectedRecords = 0;
    for (const rawResource of list(input.resourceMetrics)) {
        const resource = record(rawResource);
        const resourceAttributes = resource.resource === undefined ? undefined : record(resource.resource).attributes;
        const values = attributes(resourceAttributes);
        const identityAttributes = attributes(resourceAttributes, true);
        const resourceBase = { ...resourceIdentity(values), serviceInstanceId: attributeText(values, 'service.instance.id'),
            resourceSchemaUrl: text(resource.schemaUrl) };
        for (const rawScope of list(resource.scopeMetrics)) {
            const scope = record(rawScope);
            const instrumentation = scope.scope === undefined ? {} : record(scope.scope);
            const streamIdentity = metricAttributeIdentity([identityAttributes, attributes(instrumentation.attributes, true)]);
            for (const rawMetric of list(scope.metrics)) {
                const metric = record(rawMetric);
                const supported = ['gauge', 'sum', 'histogram'].filter(key => metric[key] !== undefined);
                const unsupported = ['exponentialHistogram', 'summary'].filter(key => metric[key] !== undefined);
                if (supported.length !== 1 || unsupported.length) {
                    for (const key of unsupported) unsupportedTypes.add(key);
                    for (const key of [...supported, ...unsupported]) rejectedRecords += list(record(metric[key]).dataPoints).length;
                    continue;
                }
                const metricType = supported[0] as 'gauge' | 'sum' | 'histogram';
                const data = record(metric[metricType]);
                for (const point of list(data.dataPoints)) {
                    try {
                        const name = text(metric.name);
                        if (!name) throw new OtlpDecodeError('Metric name is missing');
                        if (data.isMonotonic !== undefined && typeof data.isMonotonic !== 'boolean') throw new OtlpDecodeError('Invalid Sum monotonicity');
                        metrics.push(metricPoint(point, { ...resourceBase, streamIdentity, name, unit: text(metric.unit) ?? '',
                            scopeName: text(instrumentation.name), scopeVersion: text(instrumentation.version), scopeSchemaUrl: text(scope.schemaUrl),
                            temporality: metricType === 'gauge' ? 'unspecified' : metricTemporality(data.aggregationTemporality) }, metricType, data.isMonotonic === true));
                    } catch (error) { if (!(error instanceof OtlpDecodeError)) throw error; rejectedRecords += 1; }
                }
            }
        }
    }
    return { signal: 'metrics', spans: [], logs: [], metrics, rejectedRecords,
        ...(unsupportedTypes.size ? { rejectionMessage: `Unsupported OTLP metric types: ${[...unsupportedTypes].join(', ')}` } : {}) };
}

export function normalizeOtlpEnvelope(signal: OtlpSignal, envelope: unknown, normalizeStatement: NormalizeDatabaseStatement): NormalizedTelemetryBatch {
    const input = record(envelope);
    if (signal === 'metrics') return normalizeMetricsEnvelope(input);
    const spans: NormalizedSpan[] = [];
    const logs: NormalizedLog[] = [];
    let rejectedRecords = 0;
    for (const resourceValue of list(input[signal === 'traces' ? 'resourceSpans' : 'resourceLogs'])) {
        const resource = record(resourceValue);
        const resourceAttributes = resource.resource === undefined ? {} : attributes(record(resource.resource).attributes);
        const identity = resourceIdentity(resourceAttributes);
        for (const scopeValue of list(resource[signal === 'traces' ? 'scopeSpans' : 'scopeLogs'])) {
            const scope = record(scopeValue);
            for (const item of list(scope[signal === 'traces' ? 'spans' : 'logRecords'])) {
                try {
                    const scopeName = scope.scope === undefined ? undefined : text(record(scope.scope).name);
                    if (signal === 'traces') spans.push(span(item, identity, normalizeStatement, scopeName));
                    else logs.push(log(item, identity, scopeName));
                } catch (error) {
                    if (!(error instanceof OtlpDecodeError)) throw error;
                    rejectedRecords += 1;
                }
            }
        }
    }
    return { signal, spans, logs, rejectedRecords };
}
