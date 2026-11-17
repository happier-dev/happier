import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createGunzip } from 'node:zlib';
import { decodeOtlpRequest, encodeOtlpError, encodeOtlpResponse } from './codec.js';
import { normalizeOtlpEnvelope, OtlpDecodeError } from './normalization.js';
import type { OtlpReceiverOptions } from './types.js';

function failure(response: ServerResponse, status: number, message: string, json: boolean): void {
    response.statusCode = status;
    response.setHeader('content-type', json ? 'application/json' : 'application/x-protobuf');
    response.end(encodeOtlpError(status, message, json));
}

/** OTLP 1.11.1 HTTP Request mandates wire and decompressed bounds and recommends 64 MiB.
 * https://opentelemetry.io/docs/specs/otlp/#otlphttp-request */
export const OTLP_HTTP_DEFAULT_MAXIMUM_REQUEST_BYTES = 64 * 1024 * 1024;
class OtlpPayloadTooLargeError extends OtlpDecodeError {}

function readBody(request: IncomingMessage, compressed: boolean, maximumBytes: number): Promise<Uint8Array> {
    if (request.aborted || request.destroyed) return Promise.reject(new OtlpDecodeError('Unreadable OTLP body or gzip stream'));
    return new Promise((resolve, reject) => {
        const decoder = compressed ? createGunzip() : undefined;
        const stream = decoder ?? request;
        const chunks: Buffer[] = [];
        let rawBytes = 0, decodedBytes = 0, settled = false;
        const cleanup = () => {
            request.off('data', onRaw);
            request.off('error', onError);
            request.off('aborted', onAborted);
            stream.off('data', onDecoded);
            stream.off('end', onEnd);
            if (decoder) { decoder.off('error', onError); request.unpipe(decoder); }
        };
        const fail = (error: OtlpDecodeError) => {
            if (settled) return;
            settled = true;
            cleanup();
            decoder?.destroy();
            // Drain the rejected HTTP body so its socket can carry the permanent refusal.
            request.resume();
            reject(error);
        };
        const overflow = () => fail(new OtlpPayloadTooLargeError('OTLP request exceeds the ingress byte bound'));
        const onRaw = (chunk: Buffer) => { rawBytes += chunk.length; if (rawBytes > maximumBytes) overflow(); };
        const onDecoded = (chunk: Buffer) => {
            if (settled) return;
            decodedBytes += chunk.length;
            if (decodedBytes > maximumBytes) { overflow(); return; }
            chunks.push(chunk);
        };
        const onError = () => fail(new OtlpDecodeError('Unreadable OTLP body or gzip stream'));
        const onAborted = () => onError();
        const onEnd = () => { if (!settled) { settled = true; cleanup(); resolve(Buffer.concat(chunks)); } };
        request.on('error', onError);
        request.once('aborted', onAborted);
        request.on('data', onRaw);
        stream.on('data', onDecoded);
        stream.once('end', onEnd);
        if (decoder) { decoder.on('error', onError); request.pipe(decoder); }
    });
}

export function createOtlpRequestHandler<Context>(options: OtlpReceiverOptions<Context>) {
    return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        const json = contentType !== 'application/x-protobuf';
        const signal = request.url === '/v1/traces' ? 'traces' : request.url === '/v1/logs' ? 'logs' : undefined;
        if (!signal) { failure(response, 404, 'Unknown OTLP signal', json); return; }
        if (request.method !== 'POST') { response.setHeader('allow', 'POST'); failure(response, 405, 'OTLP requires POST', json); return; }
        if (contentType !== 'application/json' && contentType !== 'application/x-protobuf') { failure(response, 415, 'Unsupported OTLP content type', json); return; }
        const encoding = request.headers['content-encoding'];
        if (encoding !== undefined && encoding !== 'identity' && encoding !== 'gzip') { failure(response, 415, 'Unsupported OTLP content encoding', json); return; }
        try {
            const admission = options.admit ? await options.admit(request, signal) : { accepted: true as const, context: options.context };
            if (!admission.accepted) { failure(response, admission.status, admission.message, json); return; }
            const consume = async () => {
                const body = await readBody(request, encoding === 'gzip', options.maximumRequestBytes ?? OTLP_HTTP_DEFAULT_MAXIMUM_REQUEST_BYTES);
                const batch = normalizeOtlpEnvelope(signal, decodeOtlpRequest(signal, body, json), options.normalizeStatement);
                const result = await options.onBatch(batch, admission.context);
                if (!result.accepted) { failure(response, result.status ?? (result.retryable ? 503 : 400), result.message, json); return; }
                const rejected = batch.rejectedRecords + (result.rejectedRecords ?? 0);
                response.statusCode = 200;
                response.setHeader('content-type', json ? 'application/json' : 'application/x-protobuf');
                response.end(encodeOtlpResponse(signal, rejected, result.message ?? (rejected > 0 ? 'Invalid telemetry records were rejected' : undefined), json));
            };
            if (options.withWriter) await options.withWriter(consume);
            else await consume();
        } catch (error) {
            if (response.destroyed) return;
            failure(response, error instanceof OtlpPayloadTooLargeError ? 413 : error instanceof OtlpDecodeError ? 400 : 503,
                error instanceof OtlpDecodeError ? error.message : 'OTLP ingestion failed', json);
        }
    };
}

/** Bind only the port/interface assigned by the launch owner; default placements stay loopback. */
export async function startOtlpReceiver<Context>(options: OtlpReceiverOptions<Context> & {
    port: number;
    host?: '127.0.0.1' | '::1' | '0.0.0.0';
}): Promise<{ url: string; close: () => Promise<void> }> {
    const handler = createOtlpRequestHandler(options);
    const server = createServer((request, response) => { void handler(request, response); });
    const host = options.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(options.port, host, () => { server.off('error', onError); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OTLP listener has no TCP address');
    return {
        url: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
