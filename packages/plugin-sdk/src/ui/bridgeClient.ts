import {
    PluginHostedWebBridgeEnvelopeV1Schema,
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
    type PluginHostedWebBridgeEnvelopeV1,
    type PluginHostedWebBridgeResponseEnvelopeV1,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginUiHostApiClient,
    type PluginUiHostApiRequestOptions,
} from './hostApiClient.js';

export interface HostedWebPluginUiBridgeTransport {
    postMessage(message: PluginHostedWebBridgeEnvelopeV1): void;
}

export interface HostedWebPluginUiHostApiClientOptions {
    readonly surface: PluginUiSurfaceContextV1;
    readonly nonce: string;
    readonly transport: HostedWebPluginUiBridgeTransport;
    readonly timeoutMs?: number;
    readonly createSequence?: () => number;
}

let nextGeneratedSequence = 0;

function createDefaultSequence(): number {
    nextGeneratedSequence += 1;
    return nextGeneratedSequence;
}

function mapHostApiMethodToBridgeKind(
    method: PluginUiHostApiMethodV1,
): PluginHostedWebBridgeEnvelopeV1['kind'] | null {
    switch (method) {
        case 'requestSessionResource':
            return 'requestSessionResource';
        case 'subscribeResource':
            return 'subscribeResource';
        case 'unsubscribeResource':
            return 'unsubscribeResource';
        case 'dispatchAction':
            return 'requestHostAction';
        case 'openSurface':
            return 'openSurface';
        case 'openExternal':
            return 'openExternal';
        case 'logDiagnostic':
            return 'logDiagnostic';
        case 'copy':
            return 'copy';
        default:
            return null;
    }
}

function isPluginUiJsonRecord(
    value: PluginUiJsonValueV1,
): value is Readonly<Record<string, PluginUiJsonValueV1>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readErrorCode(payload: PluginUiJsonValueV1): PluginUiHostApiErrorCodeV1 {
    if (isPluginUiJsonRecord(payload)) {
        const code = payload.code;
        if (
            code === 'unavailable'
            || code === 'denied'
            || code === 'invalid_payload'
            || code === 'unsupported_method'
            || code === 'stale_surface'
            || code === 'expired_resource'
            || code === 'timeout'
            || code === 'internal_error'
        ) {
            return code;
        }
    }
    return 'internal_error';
}

function responseMatchesSurface(
    surface: PluginUiSurfaceContextV1,
    response: PluginHostedWebBridgeResponseEnvelopeV1,
    nonce: string,
): boolean {
    return response.nonce === nonce
        && response.pluginId === surface.pluginId
        && response.contributionId === surface.contributionId
        && response.surfaceId === surface.surfaceId
        && response.sessionId === surface.sessionId;
}

export function createHostedWebPluginUiHostApiClient(
    options: HostedWebPluginUiHostApiClientOptions,
) {
    const createSequence = options.createSequence ?? createDefaultSequence;
    const requestsBySequence = new Map<number, PluginUiHostApiRequestEnvelopeV1>();
    const sequencesByRequestId = new Map<string, number>();
    let lastCreatedRequestId: string | null = null;

    const client = createPluginUiHostApiClient({
        surface: options.surface,
        timeoutMs: options.timeoutMs,
        createRequestId: () => {
            const sequence = createSequence();
            const requestId = `hosted-web:${sequence}`;
            sequencesByRequestId.set(requestId, sequence);
            lastCreatedRequestId = requestId;
            return requestId;
        },
        transport: {
            send: (request) => {
                const sequence = sequencesByRequestId.get(request.requestId);
                const bridgeKind = mapHostApiMethodToBridgeKind(request.method);
                if (sequence === undefined || !bridgeKind) {
                    throw new Error('Unsupported hosted-web bridge request.');
                }

                requestsBySequence.set(sequence, request);
                options.transport.postMessage(PluginHostedWebBridgeEnvelopeV1Schema.parse({
                    version: 1,
                    pluginId: options.surface.pluginId,
                    contributionId: options.surface.contributionId,
                    surfaceId: options.surface.surfaceId,
                    sessionId: options.surface.sessionId,
                    nonce: options.nonce,
                    sequence,
                    kind: bridgeKind,
                    payload: request.payload ?? null,
                }));
            },
        },
    });

    function request(
        method: PluginUiHostApiMethodV1,
        payload?: PluginUiJsonValueV1,
        requestOptions?: PluginUiHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1 | undefined> {
        const promise = client.request(method, payload, requestOptions);
        const requestId = lastCreatedRequestId;
        return promise.finally(() => {
            if (!requestId) return;
            const sequence = sequencesByRequestId.get(requestId);
            sequencesByRequestId.delete(requestId);
            if (sequence !== undefined) {
                requestsBySequence.delete(sequence);
            }
        });
    }

    function handleBridgeResponse(message: unknown): void {
        const parsed = PluginHostedWebBridgeResponseEnvelopeV1Schema.safeParse(message);
        if (!parsed.success) return;
        const response = parsed.data;
        if (!responseMatchesSurface(options.surface, response, options.nonce)) return;

        const originalRequest = requestsBySequence.get(response.requestSequence);
        if (!originalRequest) return;

        client.handleMessage({
            version: 1,
            requestId: originalRequest.requestId,
            surface: originalRequest.surface,
            method: originalRequest.method,
            kind: response.kind === 'error' ? 'error' : response.kind,
            payload: response.kind === 'error'
                ? { code: readErrorCode(response.payload) }
                : response.payload,
        });
    }

    return {
        request,
        subscribeResource: client.subscribeResource,
        handleBridgeResponse,
        dispose: client.dispose,
    };
}
