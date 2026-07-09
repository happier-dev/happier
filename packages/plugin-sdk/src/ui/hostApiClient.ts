import {
    PluginUiHostApiRequestEnvelopeV1Schema,
    PluginUiHostApiResponseEnvelopeV1Schema,
    PluginUiResourceSubscriptionEventV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostApiResponseEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginSessionResourceTargetV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginUiHostApiClientMessage =
    | PluginUiHostApiResponseEnvelopeV1
    | PluginUiResourceSubscriptionEventV1;

export interface PluginUiHostApiClientTransport {
    send(request: PluginUiHostApiRequestEnvelopeV1): void | Promise<void>;
}

export interface PluginUiHostApiClientOptions {
    readonly surface: PluginUiSurfaceContextV1;
    readonly transport: PluginUiHostApiClientTransport;
    readonly timeoutMs?: number;
    readonly createRequestId?: () => string;
    readonly createSubscriptionId?: () => string;
}

export interface PluginUiHostApiRequestOptions {
    readonly timeoutMs?: number;
}

export interface PluginUiHostApiSubscription {
    readonly subscriptionId: string;
    unsubscribe(): void;
}

export class PluginUiHostApiClientError extends Error {
    readonly code: PluginUiHostApiErrorCodeV1;
    readonly requestId?: string;
    readonly method?: PluginUiHostApiMethodV1;
    readonly diagnostics: readonly string[];

    constructor(input: {
        readonly code: PluginUiHostApiErrorCodeV1;
        readonly message?: string;
        readonly requestId?: string;
        readonly method?: PluginUiHostApiMethodV1;
        readonly diagnostics?: readonly string[];
    }) {
        super(input.message ?? input.code);
        this.name = 'PluginUiHostApiClientError';
        this.code = input.code;
        this.requestId = input.requestId;
        this.method = input.method;
        this.diagnostics = input.diagnostics ?? [];
    }
}

interface PendingRequest {
    readonly requestId: string;
    readonly method: PluginUiHostApiMethodV1;
    readonly timeout: ReturnType<typeof setTimeout>;
    resolve(value: PluginUiJsonValueV1 | undefined): void;
    reject(error: PluginUiHostApiClientError): void;
}

let nextGeneratedId = 0;

function createDefaultId(prefix: string): string {
    nextGeneratedId += 1;
    return `${prefix}-${Date.now()}-${nextGeneratedId}`;
}

function isSameSurface(
    expected: PluginUiSurfaceContextV1,
    actual: PluginUiSurfaceContextV1,
): boolean {
    return expected.pluginId === actual.pluginId
        && expected.contributionId === actual.contributionId
        && expected.surfaceId === actual.surfaceId
        && expected.sessionId === actual.sessionId;
}

export function createPluginUiHostApiClient(options: PluginUiHostApiClientOptions) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const createRequestId = options.createRequestId
        ?? (() => createDefaultId('plugin-ui-request'));
    const createSubscriptionId = options.createSubscriptionId
        ?? (() => createDefaultId('plugin-ui-subscription'));
    const pending = new Map<string, PendingRequest>();
    const subscriptions = new Map<string, (event: PluginUiResourceSubscriptionEventV1) => void>();

    function settleRequest(
        requestId: string,
        settle: (pendingRequest: PendingRequest) => void,
    ): void {
        const pendingRequest = pending.get(requestId);
        if (!pendingRequest) return;
        pending.delete(requestId);
        clearTimeout(pendingRequest.timeout);
        settle(pendingRequest);
    }

    function rejectPending(
        requestId: string,
        code: PluginUiHostApiErrorCodeV1,
        message?: string,
        diagnostics?: readonly string[],
    ): void {
        settleRequest(requestId, (pendingRequest) => {
            pendingRequest.reject(new PluginUiHostApiClientError({
                code,
                message,
                requestId,
                method: pendingRequest.method,
                diagnostics,
            }));
        });
    }

    function handleResponse(response: PluginUiHostApiResponseEnvelopeV1): void {
        const pendingRequest = pending.get(response.requestId);
        if (!pendingRequest) return;
        if (pendingRequest.method !== response.method) return;
        if (!isSameSurface(options.surface, response.surface)) return;

        settleRequest(response.requestId, (request) => {
            if (response.kind === 'error') {
                request.reject(new PluginUiHostApiClientError({
                    code: response.payload.code,
                    message: response.payload.message,
                    requestId: response.requestId,
                    method: response.method,
                    diagnostics: response.payload.diagnostics,
                }));
                return;
            }
            request.resolve(response.payload);
        });
    }

    function handleSubscriptionEvent(event: PluginUiResourceSubscriptionEventV1): void {
        const listener = subscriptions.get(event.subscriptionId);
        if (!listener) return;
        listener(event);
        if (event.kind === 'complete' || event.kind === 'error') {
            subscriptions.delete(event.subscriptionId);
        }
    }

    function request(
        method: PluginUiHostApiMethodV1,
        payload?: PluginUiJsonValueV1,
        requestOptions?: PluginUiHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1 | undefined> {
        const requestId = createRequestId();
        const envelope = PluginUiHostApiRequestEnvelopeV1Schema.parse({
            version: 1,
            requestId,
            surface: options.surface,
            method,
            payload,
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                rejectPending(requestId, 'timeout');
            }, requestOptions?.timeoutMs ?? timeoutMs);

            pending.set(requestId, {
                requestId,
                method,
                timeout,
                resolve,
                reject,
            });

            try {
                Promise.resolve(options.transport.send(envelope)).catch((error: unknown) => {
                    rejectPending(
                        requestId,
                        'unavailable',
                        error instanceof Error ? error.message : undefined,
                    );
                });
            } catch (error) {
                rejectPending(
                    requestId,
                    'unavailable',
                    error instanceof Error ? error.message : undefined,
                );
            }
        });
    }

    function subscribeResource(
        resource: PluginSessionResourceTargetV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
    ): PluginUiHostApiSubscription {
        const subscriptionId = createSubscriptionId();
        subscriptions.set(subscriptionId, listener);

        try {
            void request('subscribeResource', {
                subscriptionId,
                resource,
            });
        } catch (error) {
            subscriptions.delete(subscriptionId);
            throw error;
        }

        return {
            subscriptionId,
            unsubscribe: () => {
                subscriptions.delete(subscriptionId);
                const envelope = PluginUiHostApiRequestEnvelopeV1Schema.parse({
                    version: 1,
                    requestId: createRequestId(),
                    surface: options.surface,
                    method: 'unsubscribeResource',
                    payload: { subscriptionId },
                });
                try {
                    Promise.resolve(options.transport.send(envelope)).catch(() => undefined);
                } catch {
                    // Unsubscribe is best-effort cleanup after local listener removal.
                }
            },
        };
    }

    function handleMessage(message: unknown): void {
        const response = PluginUiHostApiResponseEnvelopeV1Schema.safeParse(message);
        if (response.success) {
            handleResponse(response.data);
            return;
        }

        const event = PluginUiResourceSubscriptionEventV1Schema.safeParse(message);
        if (event.success) {
            handleSubscriptionEvent(event.data);
        }
    }

    function dispose(): void {
        for (const requestId of pending.keys()) {
            rejectPending(requestId, 'unavailable', 'Plugin UI host API client disposed.');
        }
        subscriptions.clear();
    }

    return {
        request,
        subscribeResource,
        handleMessage,
        dispose,
    };
}
