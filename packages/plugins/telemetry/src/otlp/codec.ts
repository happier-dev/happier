import protobuf from 'protobufjs';
import { otlpSchema } from './schema.js';
import { OtlpDecodeError } from './normalization.js';
import type { OtlpSignal } from './types.js';

const root = protobuf.Root.fromJSON(otlpSchema);
const statusType = root.lookupType('google.rpc.Status');
const types = {
    traces: {
        request: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'),
        response: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse'),
    },
    logs: {
        request: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest'),
        response: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse'),
    },
};

export function decodeOtlpRequest(signal: OtlpSignal, body: Uint8Array, json: boolean): unknown {
    try {
        if (json) return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
        const type = types[signal].request;
        // protobufjs is the external decoding boundary; the envelope is validated immediately afterward.
        return type.toObject(type.decode(body), { longs: String, bytes: Buffer, enums: Number });
    } catch {
        throw new OtlpDecodeError('Malformed OTLP payload');
    }
}

export function encodeOtlpResponse(signal: OtlpSignal, rejected: number, message: string | undefined, json: boolean): Uint8Array {
    const value = rejected > 0 || message ? {
        partialSuccess: {
            [signal === 'traces' ? 'rejectedSpans' : 'rejectedLogRecords']: String(rejected),
            ...(message ? { errorMessage: message } : {}),
        },
    } : {};
    if (json) return Buffer.from(JSON.stringify(value));
    const type = types[signal].response;
    return type.encode(type.fromObject(value)).finish();
}

export function encodeOtlpError(status: number, message: string, json: boolean): Uint8Array {
    // Published google.rpc.Code values, as required by OTLP/HTTP error responses.
    const code = status === 401 ? 16 : status === 403 ? 7 : status === 404 ? 5
        : status === 405 ? 12 : status === 413 || status === 429 || status === 507 ? 8 : status === 503 ? 14 : 3;
    const value = { code, message };
    return json ? Buffer.from(JSON.stringify(value)) : statusType.encode(statusType.fromObject(value)).finish();
}
