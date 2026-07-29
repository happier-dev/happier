import {
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
    PluginUiHostApiRequestEnvelopeV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    PluginUiResourceUnsubscribeRequestV1Schema,
    type PluginHostedWebBridgeEnvelopeV1,
    type PluginHostedWebBridgeResponseEnvelopeV1,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginUiHostReadyStateStore,
    pluginUiSurfaceContextsMatch,
    type PluginUiHostReadyStateChange,
    type PluginUiHostReadyStateSnapshot,
} from './readyState';
import {
    createPluginUiHostSubscriptionRegistry,
    type PluginUiHostSubscriptionAuditEvent,
} from './subscriptions';

export type PluginHostedWebHostApiRequestHandler = (
    request: PluginUiHostApiRequestEnvelopeV1,
) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;

export type PluginHostedWebHostApiAuditEvent =
    | PluginUiHostSubscriptionAuditEvent
    | Readonly<{
        type: 'readyRecorded' | 'readyDuplicate' | 'readyStale' | 'readyTimedOut';
        surface: PluginUiSurfaceContextV1;
    }>;

export type PluginHostedWebHostApiBridgeHandler = ((
    envelope: PluginHostedWebBridgeEnvelopeV1,
) => Promise<PluginHostedWebBridgeResponseEnvelopeV1>) & Readonly<{
    publishSubscriptionEvent(event: PluginUiResourceSubscriptionEventV1): boolean;
    getReadyState(): PluginUiHostReadyStateSnapshot;
    recordReadyTimeout(): PluginUiHostReadyStateSnapshot;
    dispose(): void;
}>;

function createBridgeResponse(params: Readonly<{
    envelope: PluginHostedWebBridgeEnvelopeV1;
    kind: PluginHostedWebBridgeResponseEnvelopeV1['kind'];
    payload: PluginUiJsonValueV1;
}>): PluginHostedWebBridgeResponseEnvelopeV1 {
    return PluginHostedWebBridgeResponseEnvelopeV1Schema.parse({
        version: 1,
        pluginId: params.envelope.pluginId,
        contributionId: params.envelope.contributionId,
        surfaceId: params.envelope.surfaceId,
        sessionId: params.envelope.sessionId,
        nonce: params.envelope.nonce,
        sequence: params.envelope.sequence,
        requestSequence: params.envelope.sequence,
        kind: params.kind,
        payload: params.payload,
    });
}

function createBridgeError(
    envelope: PluginHostedWebBridgeEnvelopeV1,
    code: PluginUiHostApiErrorCodeV1,
    diagnostics: readonly string[] = [],
): PluginHostedWebBridgeResponseEnvelopeV1 {
    return createBridgeResponse({
        envelope,
        kind: 'error',
        payload: {
            code,
            diagnostics: [...diagnostics],
        },
    });
}

function mapBridgeMessageToHostApiMethod(
    kind: PluginHostedWebBridgeEnvelopeV1['kind'],
): PluginUiHostApiMethodV1 | null {
    switch (kind) {
        case 'requestSessionResource':
            return 'requestSessionResource';
        case 'subscribeResource':
            return 'subscribeResource';
        case 'unsubscribeResource':
            return 'unsubscribeResource';
        case 'requestHostAction':
            return 'dispatchAction';
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

function isLifecycleBridgeMessage(kind: PluginHostedWebBridgeEnvelopeV1['kind']): boolean {
    return kind === 'heightChanged'
        || kind === 'error';
}

function isJsonRecord(value: PluginUiJsonValueV1 | undefined): value is Record<string, PluginUiJsonValueV1> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeUnsubscribeResult(params: Readonly<{
    result: PluginUiJsonValueV1;
    subscriptionId: string;
    disposed: boolean;
}>): PluginUiJsonValueV1 {
    return {
        ...(isJsonRecord(params.result) ? params.result : {}),
        accepted: true,
        subscriptionId: params.subscriptionId,
        disposed: params.disposed,
    };
}

function createSubscriptionRetirementRequest(input: Readonly<{
    requestIdPrefix: string;
    surface: PluginUiSurfaceContextV1;
    subscriptionId: string;
}>): PluginUiHostApiRequestEnvelopeV1 {
    return PluginUiHostApiRequestEnvelopeV1Schema.parse({
        version: 1,
        requestId: `${input.requestIdPrefix}:retire:${input.subscriptionId}`,
        surface: input.surface,
        method: 'unsubscribeResource',
        payload: {
            subscriptionId: input.subscriptionId,
        },
    });
}

export function createPluginHostedWebHostApiBridgeHandler(params: Readonly<{
    surface: PluginUiSurfaceContextV1;
    requestIdPrefix: string;
    handleRequest?: PluginHostedWebHostApiRequestHandler;
    deliverSubscriptionEvent?: (event: PluginUiResourceSubscriptionEventV1) => void;
    onReadyStateChange?: (state: PluginUiHostReadyStateChange) => void;
    audit?: (event: PluginHostedWebHostApiAuditEvent) => void;
    nowMs?: () => number;
}>): PluginHostedWebHostApiBridgeHandler {
    const readyState = createPluginUiHostReadyStateStore({ nowMs: params.nowMs });
    const subscriptions = createPluginUiHostSubscriptionRegistry({
        deliverSubscriptionEvent: params.deliverSubscriptionEvent,
        audit: params.audit,
    });
    const settledSubscriptionIds = new Set<string>();
    let disposed = false;

    async function handleBridgeEnvelope(
        envelope: PluginHostedWebBridgeEnvelopeV1,
    ): Promise<PluginHostedWebBridgeResponseEnvelopeV1> {
        if (disposed) {
            return createBridgeError(envelope, 'unavailable', ['host_api_handler_disposed']);
        }
        if (!pluginUiSurfaceContextsMatch(params.surface, envelope)) {
            params.audit?.({ type: 'readyStale', surface: params.surface });
            return createBridgeError(envelope, 'stale_surface');
        }

        if (envelope.kind === 'ready') {
            const recorded = readyState.recordReady(params.surface);
            if (recorded.result === 'recorded') {
                params.onReadyStateChange?.({
                    state: 'ready',
                    surface: params.surface,
                    updatedAtMs: recorded.snapshot.updatedAtMs,
                    diagnostics: [],
                });
                params.audit?.({ type: 'readyRecorded', surface: params.surface });
            } else {
                params.audit?.({ type: 'readyDuplicate', surface: params.surface });
            }
            return createBridgeResponse({
                envelope,
                kind: 'ack',
                payload: {
                    accepted: true,
                    surface: params.surface,
                    readyState: recorded.result,
                },
            });
        }

        if (isLifecycleBridgeMessage(envelope.kind)) {
            return createBridgeResponse({
                envelope,
                kind: 'ack',
                payload: { accepted: true },
            });
        }

        const method = mapBridgeMessageToHostApiMethod(envelope.kind);
        if (!method) {
            return createBridgeError(envelope, 'unsupported_method');
        }
        if (!params.handleRequest) {
            return createBridgeError(envelope, 'unavailable', ['host_api_handler_unavailable']);
        }

        const request = PluginUiHostApiRequestEnvelopeV1Schema.safeParse({
            version: 1,
            requestId: `${params.requestIdPrefix}:${envelope.sequence}`,
            surface: params.surface,
            method,
            payload: envelope.payload,
        });
        if (!request.success) {
            return createBridgeError(envelope, 'invalid_payload');
        }

        if (method === 'subscribeResource') {
            const subscribePayload = PluginUiResourceSubscriptionRequestV1Schema.safeParse(envelope.payload);
            if (!subscribePayload.success) {
                return createBridgeError(envelope, 'invalid_payload');
            }
            subscriptions.register({
                surface: params.surface,
                subscriptionId: subscribePayload.data.subscriptionId,
            });
            try {
                const result = await params.handleRequest(request.data);
                if (disposed) {
                    subscriptions.dispose({
                        surface: params.surface,
                        subscriptionId: subscribePayload.data.subscriptionId,
                    });
                    try {
                        await params.handleRequest(createSubscriptionRetirementRequest({
                            requestIdPrefix: params.requestIdPrefix,
                            surface: params.surface,
                            subscriptionId: subscribePayload.data.subscriptionId,
                        }));
                    } catch {
                        // The retired bridge stays unavailable even when host cleanup fails.
                    }
                    return createBridgeError(envelope, 'unavailable', ['host_api_handler_disposed']);
                }
                settledSubscriptionIds.add(subscribePayload.data.subscriptionId);
                return createBridgeResponse({
                    envelope,
                    kind: 'result',
                    payload: result,
                });
            } catch {
                subscriptions.dispose({
                    surface: params.surface,
                    subscriptionId: subscribePayload.data.subscriptionId,
                });
                return createBridgeError(envelope, 'internal_error', ['host_api_handler_failed']);
            }
        }

        if (method === 'unsubscribeResource') {
            const unsubscribePayload = PluginUiResourceUnsubscribeRequestV1Schema.safeParse(envelope.payload);
            if (!unsubscribePayload.success) {
                return createBridgeError(envelope, 'invalid_payload');
            }
            const disposed = subscriptions.dispose({
                surface: params.surface,
                subscriptionId: unsubscribePayload.data.subscriptionId,
            });
            settledSubscriptionIds.delete(unsubscribePayload.data.subscriptionId);
            try {
                return createBridgeResponse({
                    envelope,
                    kind: 'result',
                    payload: mergeUnsubscribeResult({
                        result: await params.handleRequest(request.data),
                        subscriptionId: unsubscribePayload.data.subscriptionId,
                        disposed,
                    }),
                });
            } catch {
                return createBridgeError(envelope, 'internal_error', ['host_api_handler_failed']);
            }
        }

        if (method === 'logDiagnostic') {
            try {
                await params.handleRequest(request.data);
                return createBridgeResponse({
                    envelope,
                    kind: 'ack',
                    payload: { accepted: true },
                });
            } catch {
                return createBridgeError(envelope, 'internal_error', ['host_api_handler_failed']);
            }
        }

        try {
            return createBridgeResponse({
                envelope,
                kind: 'result',
                payload: await params.handleRequest(request.data),
            });
        } catch {
            return createBridgeError(envelope, 'internal_error', ['host_api_handler_failed']);
        }
    }

    const handler = Object.assign(handleBridgeEnvelope, {
        publishSubscriptionEvent: (event: PluginUiResourceSubscriptionEventV1): boolean => {
            const published = subscriptions.publish(params.surface, event);
            if (published && (event.kind === 'complete' || event.kind === 'error')) {
                settledSubscriptionIds.delete(event.subscriptionId);
            }
            return published;
        },
        getReadyState: (): PluginUiHostReadyStateSnapshot => readyState.read(params.surface),
        recordReadyTimeout: (): PluginUiHostReadyStateSnapshot => {
            const snapshot = readyState.recordTimeout(params.surface);
            if (snapshot.state === 'timedOut') {
                params.onReadyStateChange?.({
                    state: 'timedOut',
                    surface: params.surface,
                    updatedAtMs: snapshot.updatedAtMs,
                    diagnostics: snapshot.diagnostics,
                });
                params.audit?.({ type: 'readyTimedOut', surface: params.surface });
            }
            return snapshot;
        },
        dispose: (): void => {
            const activeSubscriptionIds = [...settledSubscriptionIds];
            disposed = true;
            settledSubscriptionIds.clear();
            subscriptions.disposeSurface(params.surface);
            readyState.reset(params.surface);
            for (const subscriptionId of activeSubscriptionIds) {
                try {
                    const cleanup = params.handleRequest?.(createSubscriptionRetirementRequest({
                        requestIdPrefix: params.requestIdPrefix,
                        surface: params.surface,
                        subscriptionId,
                    }));
                    void Promise.resolve(cleanup).catch(() => undefined);
                } catch {
                    // The bridge is retired even when host cleanup fails synchronously.
                }
            }
        },
    });

    return handler;
}
