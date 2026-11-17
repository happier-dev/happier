import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { parseQualifiedPluginActionId, formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { projectActionFailureCauseV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3, ProviderBrokerActionExecuteRequestV3Schema, ProviderBrokerActionExecuteResponseV3Schema, type SignedProviderBrokerActionRouteGrantV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import fastify, { errorCodes, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { constants } from 'node:os';
import { AxiosError } from 'axios';
import { z } from 'zod/mini';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1, TeamCredentialProviderBrokerApplicationCarrierRequestV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';

import { startFirstBytesLocalCapabilityProxy, type FirstBytesLocalCapabilityProxy } from '@/daemon/peer/mediation/loopback/firstBytesLocalCapability';
import type {
    ProviderBrokerApplicationStreamLifetime,
    ProviderBrokerAuthenticatedStreamContext,
    ProviderBrokerRequestHandler,
} from './providerBrokerRequestHandler';
import { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER, PROVIDER_BROKER_PRIVATE_CLOSE_PATH,
    PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER } from './providerBrokerPrivateProtocol';
import { logger } from '@/ui/logger';
import { isConnectedAccountSourceReconnectRequiredError } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { ProviderBrokerApplicationPhaseError } from './providerBrokerApplicationFailureContext';
import { ProviderBrokerApplicationFailureError, providerBrokerApplicationFailureBody, providerBrokerApplicationFailureHeaders, type ProviderBrokerApplicationFailure } from './providerBrokerApplicationFailure';
export { PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER, PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
export { PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER } from './providerBrokerPrivateProtocol';

export type ProviderBrokerApplicationStreamTarget = Readonly<{
    port: number;
    localCapability: string;
}>;

export type ProviderBrokerActionStreamContext = Readonly<{
    kind: 'action_operation';
    authority: SignedProviderBrokerActionRouteGrantV3;
    execute(request: Readonly<{ input: JsonValue; signal: AbortSignal }>): Promise<ActionExecuteResult>;
}>;
type ApplicationStreamContext = ProviderBrokerAuthenticatedStreamContext | ProviderBrokerActionStreamContext;

export type StartedProviderBrokerApplicationServer = Readonly<{
    app: FastifyInstance;
    /** Runner-owned access endpoint; its request owner obtains current daemon custody. */
    localConsumerEndpointUrl?: string;
    createStreamTarget(
        context: ProviderBrokerAuthenticatedStreamContext,
        admissionSignal?: AbortSignal,
    ): Promise<ProviderBrokerApplicationStreamTarget>;
    createActionStreamTarget(context: ProviderBrokerActionStreamContext, admissionSignal?: AbortSignal): Promise<ProviderBrokerApplicationStreamTarget>;
    close(): Promise<void>;
}>;

const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);
const closeRequestIdSchema = z.uuid();
// These are diagnostic classifications, never arbitrary error properties:
// Provider exceptions can contain credentials even in their name/code fields.
const APPLICATION_ERROR_NAMES = new Set([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
    'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError',
    'AxiosError', 'CanceledError', 'ZodError', '$ZodError', 'FastifyError',
]);

type ProviderBrokerApplicationFailureReply = Readonly<{
    header(name: string, value: string): unknown;
    code(statusCode: number): Readonly<{
        send(payload?: unknown): unknown;
    }>;
}>;

export function writeProviderBrokerApplicationFailure(
    reply: ProviderBrokerApplicationFailureReply,
    response: ProviderBrokerApplicationFailure,
    resourceId?: string,
) {
    for (const [name, value] of Object.entries(providerBrokerApplicationFailureHeaders(response))) reply.header(name, value);
    reply.header('content-type', 'application/json');
    // `broker_unavailable` is the one retryable failure (an unexpected broker
    // fault); every other typed reason is an authority or policy refusal.
    return reply.code(response.reasonCode === 'broker_unavailable' ? 503 : 403)
        .send(providerBrokerApplicationFailureBody(response, resourceId));
}

function loopbackPort(app: FastifyInstance): number {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Provider broker application server is not listening');
    return address.port;
}

/**
 * Starts the one target-daemon Provider application. Each admitted machine/1
 * stream receives a one-connection first-bytes proxy. The proxy's target TCP
 * port is used as an unforgeable, process-local lookup key for the exact QUIC
 * endpoint and signed binding verified by admission; request headers never
 * supply transport identity.
 */
export async function startProviderBrokerApplicationServer(input: Readonly<{
    handler: ProviderBrokerRequestHandler;
    localConsumer?: Readonly<{
        authorize(headers: Readonly<Record<string, string>>): boolean;
        request(request: ManagedServiceRequest): ReturnType<ProviderBrokerRequestHandler>;
    }>;
}>): Promise<StartedProviderBrokerApplicationServer> {
    const contextsByRemotePort = new Map<number, ApplicationStreamContext>();
    const proxies = new Set<FirstBytesLocalCapabilityProxy>();
    const streamLifetimes = new Set<Pick<ProviderBrokerApplicationStreamLifetime, 'close' | 'retire'>>();
    const app = fastify({ logger: false });
    // This private, authenticated carrier carries complete requests. Fastify's
    // string/buffer parsers impose an unrelated default body cap, so consume
    // its cancellable payload stream and retain its secure JSON decoder.
    const parseJson = app.getDefaultJsonParser('error', 'error');
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', async (request: FastifyRequest, payload: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
            if (Buffer.isBuffer(chunk)) chunks.push(chunk);
            else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
            else throw new TypeError('Invalid Provider carrier body chunk');
        }
        return await new Promise<unknown>((resolve, reject) => parseJson(request, Buffer.concat(chunks).toString('utf8'), (error, body) => {
            if (error) reject(error);
            else resolve(body);
        }));
    });
    const requestDiagnostic = (request: FastifyRequest) => {
        const remotePort = request.raw.socket.remotePort;
        const context = remotePort === undefined ? undefined : contextsByRemotePort.get(remotePort);
        if (!context || context.kind === 'external' || context.kind === 'action_operation') return { applicationRequestId: request.id };
        const consumer = context.authority.payload.consumer;
        const grantId = closeRequestIdSchema.safeParse(context.authority.payload.grantId);
        return { applicationRequestId: request.id,
            consumerId: consumer.kind === 'session' ? consumer.sessionId : consumer.executionRunId,
            ...(grantId.success ? { grantId: grantId.data } : {}) };
    };
    app.addHook('onError', async (request, _reply, error) => {
        const failure = error instanceof ProviderBrokerApplicationPhaseError ? error : null;
        const original = failure?.cause instanceof Error ? failure.cause : error;
        const code = 'code' in original ? original.code : undefined;
        const errorCode = typeof code === 'string' && (
            Object.hasOwn(constants.errno, code)
            || Object.hasOwn(errorCodes, code)
            || Object.getOwnPropertyDescriptor(AxiosError, code)?.value === code
        ) ? code : undefined;
        logger.warnLocalFile('[provider-broker-application]', {
            stage: 'handler', code: 'exception',
            phase: failure?.phase ?? 'handler',
            ...requestDiagnostic(request),
            ...(failure ? { brokerRequestId: failure.brokerRequestId } : {}),
            errorName: APPLICATION_ERROR_NAMES.has(original.name) ? original.name : 'UnknownError',
            ...(errorCode ? { errorCode } : {}),
        });
    });
    app.setErrorHandler((error: FastifyError, _request, reply) => {
        const original = error instanceof ProviderBrokerApplicationPhaseError ? error.cause : error;
        if (original instanceof ProviderBrokerApplicationFailureError) return writeProviderBrokerApplicationFailure(reply, original.failure);
        if (isConnectedAccountSourceReconnectRequiredError(original)) return writeProviderBrokerApplicationFailure(reply, {
            ok: false, reasonCode: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
        });
        // Preserve Fastify's parser/size refusals. Unexpected application
        // failures use the same closed refusal as other broker unavailability,
        // so neither its default 500 body nor Provider exception text escapes.
        if (error.statusCode && error.statusCode < 500 && Object.hasOwn(errorCodes, error.code)) return reply.send(error);
        return writeProviderBrokerApplicationFailure(reply, { ok: false, reasonCode: 'broker_unavailable',
            failureCause: projectActionFailureCauseV1(original) });
    });

    const sendResponse = async (
        reply: FastifyReply,
        response: Awaited<ReturnType<ProviderBrokerRequestHandler>>,
        requestSignal: AbortSignal,
        applicationRequestId: string,
        context?: ProviderBrokerAuthenticatedStreamContext,
    ) => {
        if (response.ok && response.response.status >= 400) {
            const reasonCode = response.response.headers[PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER];
            if (reasonCode === 'broker_unavailable' || reasonCode === 'source_unavailable'
                || reasonCode === 'connected_service_credential_reconnect_required') {
                await response.response.body?.cancel().catch(() => undefined);
                response = { ok: false, reasonCode };
            }
        }
        if (!response.ok) {
            logger.warnLocalFile('[provider-broker-application]', { stage: 'application_response', applicationRequestId, code: response.reasonCode,
                ...(response.sourceOpenFailureReason ? { sourceOpenFailureReason: response.sourceOpenFailureReason } : {}) });
            return writeProviderBrokerApplicationFailure(
                reply,
                response,
                // Only the private stream has a recipient Session to attribute
                // the refusal to; the external carrier answers an API key.
                context && context.kind !== 'external' && context.kind !== 'account_connection' ? context.expected.resourceId : undefined,
            );
        }
        const recordResponseFailure = (outcome: 'failed' | 'cancelled', responseBytes: number): void => {
            try {
                logger.warnLocalFile('[provider-broker-application]', {
                    stage: 'response_body', applicationRequestId, httpStatus: response.response.status,
                    outcome, responseBytes,
                });
            } catch { /* File diagnostics cannot affect forwarding or cleanup. */ }
        };
        for (const [name, value] of Object.entries(response.response.headers)) {
            if (!RESPONSE_HOP_BY_HOP_HEADERS.has(name.toLowerCase())) reply.header(name, value);
        }
        reply.code(response.response.status);
        if (!response.response.body) {
            if (response.response.status >= 400) recordResponseFailure('failed', 0);
            return reply.send();
        }
        const responseBody = response.response.body;
        const reader = responseBody.getReader();
        let cancellationRequested = false;
        const cancelBody = (): void => {
            if (cancellationRequested) return;
            cancellationRequested = true;
            void reader.cancel().catch(() => undefined);
        };
        reply.raw.once('close', cancelBody);
        requestSignal.addEventListener('abort', cancelBody, { once: true });
        return reply.send(Readable.from((async function* () {
            let completed = false;
            let responseBytes = 0;
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) {
                        completed = true;
                        return;
                    }
                    responseBytes += next.value.byteLength;
                    yield Buffer.from(next.value);
                }
            } finally {
                if (cancellationRequested || !completed || response.response.status >= 400) {
                    recordResponseFailure(cancellationRequested ? 'cancelled' : 'failed', responseBytes);
                }
                reply.raw.off('close', cancelBody);
                requestSignal.removeEventListener('abort', cancelBody);
                if (!completed) await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
        })()));
    };

    app.post(PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3, async (request, reply) => {
        const remotePort = request.raw.socket.remotePort;
        const context = remotePort === undefined ? undefined : contextsByRemotePort.get(remotePort);
        if (!context || context.kind !== 'action_operation') return reply.code(403).send({ ok: false, reasonCode: 'resource_forbidden' });
        const parsed = ProviderBrokerActionExecuteRequestV3Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const actionId = parseQualifiedPluginActionId(context.authority.payload.consumer.actionId);
        if (!actionId || computeActionInputApprovalDigestV1(formatQualifiedPluginActionId(actionId), parsed.data.input) !== context.authority.payload.inputDigest) {
            return reply.code(403).send({ ok: false, reasonCode: 'resource_forbidden' });
        }
        // One admitted stream executes one finite Action, even when the peer
        // pipelines HTTP requests on its authenticated TCP connection.
        contextsByRemotePort.delete(remotePort!);
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.raw.once('aborted', abort);
        reply.raw.once('close', abort);
        try {
            const execution = await context.execute({ input: parsed.data.input, signal: controller.signal });
            controller.signal.throwIfAborted();
            return reply.send(ProviderBrokerActionExecuteResponseV3Schema.parse({ ok: true, execution }));
        } catch (error) {
            const failure = error instanceof ProviderBrokerApplicationFailureError ? error.failure
                : { ok: false as const, reasonCode: isConnectedAccountSourceReconnectRequiredError(error)
                    ? 'connected_service_credential_reconnect_required' as const : 'broker_unavailable' as const,
                    failureCause: projectActionFailureCauseV1(error) };
            return reply.code(failure.reasonCode === 'broker_unavailable' ? 503 : 403)
                .send(ProviderBrokerActionExecuteResponseV3Schema.parse(failure));
        } finally {
            request.raw.off('aborted', abort);
            reply.raw.off('close', abort);
        }
    });

    app.post(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1, async (request, reply) => {
        const remotePort = request.raw.socket.remotePort;
        const context = remotePort === undefined ? undefined : contextsByRemotePort.get(remotePort);
        if (!context || context.kind !== 'external') return reply.code(403).send();
        const parsed = TeamCredentialProviderBrokerApplicationCarrierRequestV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send();
        const controller = new AbortController();
        request.raw.once('aborted', () => controller.abort());
        reply.raw.once('close', () => controller.abort());
        const result = await input.handler({
            context,
            carrierRequest: parsed.data,
            request: {
                pathAndQuery: parsed.data.pathAndQuery,
                method: parsed.data.method,
                headers: parsed.data.headers,
                ...(parsed.data.bodyBase64 ? { body: decodeBase64(parsed.data.bodyBase64, 'base64') } : {}),
                signal: controller.signal,
            },
        });
        return await sendResponse(reply, result, controller.signal, request.id);
    });

    app.register(async (inference) => {
        // Keep the one ingress buffer. The request policy owns JSON parsing;
        // parsing here would serialize a second copy before that evaluation.
        inference.removeAllContentTypeParsers();
        inference.addContentTypeParser(['application/json', 'text/plain'], {
            parseAs: 'buffer',
            bodyLimit: Number.MAX_SAFE_INTEGER,
        }, (_request, body, done) => done(null, body));
        inference.route<{ Body: Uint8Array }>({
            method: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
            url: '/v1/*',
            // Fastify requires a positive integer. Its maximum representable byte
            // count disables the default application cap; transport frames bound
            // their own chunks, not the total inference request.
            bodyLimit: Number.MAX_SAFE_INTEGER,
            handler: async (request, reply) => {
                const remotePort = request.raw.socket.remotePort;
                const context = remotePort === undefined ? undefined : contextsByRemotePort.get(remotePort);
                const headers: Record<string, string> = {};
                for (const [name, value] of Object.entries(request.headers)) {
                    if (typeof value === 'string') headers[name] = value;
                }
                const localConsumer = !context ? input.localConsumer : undefined;
                // Only private/Account model streams forward inference here.
                const streamContext = context && context.kind !== 'external' && context.kind !== 'action_operation'
                    ? context : undefined;
                if (localConsumer ? !localConsumer.authorize(headers) : !streamContext) {
                    return reply.code(403).send();
                }
                // The Agent's bearer is its local capability, meaningful only to
                // the tunnel; authority comes from the stream's admission.
                delete headers.authorization;
                // Private diagnostics must never become upstream Provider headers.
                delete headers[PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER];
                // The canonical request-policy owner needs the complete
                // Connection context to remove its nominated headers together.
                const body = request.body;
                const controller = new AbortController();
                request.raw.once('aborted', () => controller.abort());
                reply.raw.once('close', () => controller.abort());
                const forwardedRequest: ManagedServiceRequest = {
                    pathAndQuery: request.raw.url ?? request.url,
                    method: request.method as ManagedServiceRequest['method'],
                    headers,
                    ...(body ? { body } : {}),
                    signal: controller.signal,
                };
                const privateClose = streamContext
                    && request.method === 'DELETE' && forwardedRequest.pathAndQuery === PROVIDER_BROKER_PRIVATE_CLOSE_PATH;
                const suppliedCloseId = privateClose
                    ? closeRequestIdSchema.safeParse(request.headers[PROVIDER_BROKER_CLOSE_REQUEST_ID_HEADER])
                    : null;
                const closeDiagnostic = privateClose ? {
                    // Older initiators omit this optional header. Invalid text
                    // is never logged or treated as transport/operation authority.
                    requestId: suppliedCloseId?.success ? suppliedCloseId.data : request.id,
                    applicationRequestId: request.id,
                    targetMachineId: streamContext.authority.payload.target.machineId,
                } : null;
                const recordClose = (event: 'received' | 'retirement_completed'): void => {
                    if (!closeDiagnostic) return;
                    try {
                        logger.infoFile('[provider-broker-close]', { ...closeDiagnostic, event });
                    } catch {
                        // File diagnostics cannot change the private close outcome.
                    }
                };
                recordClose('received');
                const result = localConsumer
                    ? await localConsumer.request(forwardedRequest)
                    : await input.handler({ context: streamContext, request: forwardedRequest });
                // The canonical handler returns 204 only after retirement.
                if (result.ok && result.response.status === 204) recordClose('retirement_completed');
                return await sendResponse(reply, result, controller.signal, request.id, streamContext);
            },
        });
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const createStreamTarget = async (
        context: ApplicationStreamContext,
        admissionSignal?: AbortSignal,
    ): Promise<ProviderBrokerApplicationStreamTarget> => {
        // Admission owns an unclaimed target. Once the one-shot capability is
        // accepted, the authenticated stream and proxy-close path own it.
        admissionSignal?.throwIfAborted();
        let registeredPort: number | null = null;
        const proxy = await startFirstBytesLocalCapabilityProxy({
            targetPort: loopbackPort(app),
            ...(admissionSignal ? { abortSignalUntilClaimed: admissionSignal } : {}),
            onTargetConnected: ({ localPort }) => {
                registeredPort = localPort;
                contextsByRemotePort.set(localPort, context);
            },
        });
        proxies.add(proxy);
        const streamLifetime = 'streamLifetime' in context
            ? context.streamLifetime
            : undefined;
        if (streamLifetime) streamLifetimes.add(streamLifetime);
        void proxy.closed.finally(async () => {
            proxies.delete(proxy);
            if (registeredPort !== null) contextsByRemotePort.delete(registeredPort);
            if (streamLifetime) {
                const released = await streamLifetime.close().then(
                    () => true,
                    () => false,
                );
                if (released) streamLifetimes.delete(streamLifetime);
            }
        });
        if (admissionSignal?.aborted) {
            await proxy.close();
            await streamLifetime?.close().catch(() => undefined);
            admissionSignal.throwIfAborted();
        }
        return { port: proxy.port, localCapability: proxy.localCapability };
    };
    return Object.freeze({
        app,
        ...(input.localConsumer ? { localConsumerEndpointUrl: `http://127.0.0.1:${loopbackPort(app)}` } : {}),
        createStreamTarget,
        createActionStreamTarget: createStreamTarget,
        close: async () => {
            await Promise.all([...proxies].map(async (proxy) => await proxy.close()));
            await Promise.all([...streamLifetimes].map(async (lifetime) => await lifetime.close()));
            streamLifetimes.clear();
            contextsByRemotePort.clear();
            await app.close();
        },
    });
}
