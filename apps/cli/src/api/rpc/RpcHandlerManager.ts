/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
    type RpcHandlerActiveExecution,
} from './types';
import { Socket } from 'socket.io-client';
import {
    SOCKET_RPC_EVENTS,
    SocketRpcCancellationPayloadSchema,
    SocketRpcRequestIdSchema,
    SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
    type SocketRpcTransportAcknowledgementV1,
} from '@happier-dev/protocol/socketRpc';
import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
} from '@happier-dev/protocol';
import {
    isSocketRpcActionApiServerOriginAuthorizationContext,
    isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext,
    isSocketRpcSessionServerStartServerOriginAuthorizationContext,
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
} from '@happier-dev/protocol/rpc';

type OwnedHandlerRegistrationContext = {
    ownerId: string;
    previousMethods: ReadonlySet<string>;
    nextMethods: Set<string>;
};

export type RpcHandlerRegistrationReadiness =
    | Readonly<{ status: 'ready' }>
    | Readonly<{
        status: 'timeout' | 'disconnected';
        missingMethods: readonly string[];
    }>;

type RegistrationReadinessWaiter = Readonly<{
    requiredMethods: readonly string[];
    requiredPrefixedMethods: ReadonlySet<string>;
    resolve: (result: RpcHandlerRegistrationReadiness) => void;
    timeout: ReturnType<typeof setTimeout>;
}>;

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly transport:
        | Readonly<{ mode: 'plain' }>
        | Readonly<{
            mode: 'e2ee';
            encryptionKey: Uint8Array;
            encryptionVariant: 'legacy' | 'dataKey';
        }>;
    private readonly authorizeRequest: RpcHandlerConfig['authorizeRequest'];
    private readonly projectTransportAcknowledgement:
        RpcHandlerConfig['projectTransportAcknowledgement'];
    private readonly logger: (message: string, data?: any) => void;
    private readonly onRegistrationError: RpcHandlerConfig['onRegistrationError'];
    private readonly onRegistrationAcknowledged:
        RpcHandlerConfig['onRegistrationAcknowledged'];
    private readonly nowMs: () => number;
    private socket: Socket | null = null;
    private acknowledgedRegistrationMethods = new Set<string>();
    private registrationReadinessWaiters = new Set<RegistrationReadinessWaiter>();
    private inFlightRequestCount = 0;
    private activeTransportRequestControllers = new Set<AbortController>();
    /**
     * The authenticated relay stamps this short-lived id immediately before it
     * dispatches here. It is deliberately transport-local: a caller cannot
     * cancel another caller's work by reusing its own outbound id.
     */
    private activeTransportRequestControllersByRequestId = new Map<string, AbortController>();
    private idleResolvers = new Set<() => void>();
    private nextHandlerExecutionId = 1;
    private activeHandlerExecutions = new Map<number, Readonly<{
        method: string;
        startedAtMs: number;
    }>>();
    private readonly ownedHandlerMethodsByOwner = new Map<string, Set<string>>();
    private ownedHandlerRegistration: OwnedHandlerRegistrationContext | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.transport = config.encryptionMode === 'plain'
            ? { mode: 'plain' }
            : {
                mode: 'e2ee',
                encryptionKey: config.encryptionKey,
                encryptionVariant: config.encryptionVariant,
            };
        this.authorizeRequest = config.authorizeRequest;
        this.projectTransportAcknowledgement =
            config.projectTransportAcknowledgement;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
        this.onRegistrationError = config.onRegistrationError;
        this.onRegistrationAcknowledged = config.onRegistrationAcknowledged;
        this.nowMs = config.nowMs ?? (() => performance.now());
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const ownedRegistration = this.ownedHandlerRegistration;
        if (ownedRegistration) {
            ownedRegistration.nextMethods.add(method);
        } else {
            for (const methods of this.ownedHandlerMethodsByOwner.values()) {
                methods.delete(method);
            }
        }
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket) {
            this.acknowledgedRegistrationMethods.delete(prefixedMethod);
            this.socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        const parsedRequestId = request.requestId === undefined
            ? null
            : SocketRpcRequestIdSchema.safeParse(request.requestId);
        if (parsedRequestId && !parsedRequestId.success) {
            return this.encodeTransportResponse(request, {
                error: 'Invalid RPC request correlation',
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
        const requestId = parsedRequestId && parsedRequestId.success
            ? parsedRequestId.data
            : null;
        if (requestId && this.activeTransportRequestControllersByRequestId.has(requestId)) {
            // A duplicate target-side id must not replace the first controller:
            // doing so would let one cancel event abort the wrong live effect.
            return this.encodeTransportResponse(request, {
                error: 'RPC request correlation collision',
                errorCode: RPC_ERROR_CODES.FORBIDDEN,
            });
        }
        this.beginInFlightRequest();
        const controller = new AbortController();
        this.activeTransportRequestControllers.add(controller);
        if (requestId) {
            this.activeTransportRequestControllersByRequestId.set(requestId, controller);
        }
        const timeoutMs = typeof request.timeoutMs === 'number'
            && Number.isSafeInteger(request.timeoutMs)
            && request.timeoutMs > 0
            ? request.timeoutMs
            : null;
        const timeout = timeoutMs === null
            ? null
            : setTimeout(() => controller.abort(new Error('RPC request timed out')), timeoutMs);
        let handlerExecutionId: number | null = null;
        try {
            const isReservedAutomationReplyHandoff = this.isReservedAutomationReplyHandoffRequest(request);
            const isReservedSessionServerStart = this.isReservedSessionServerStartRequest(request);
            const isReservedActionApi = this.isReservedActionApiRequest(request);
            const isReservedServerOriginRequest = isReservedAutomationReplyHandoff
                || isReservedSessionServerStart
                || isReservedActionApi;
            const isServerOriginAutomationReplyHandoff = isReservedAutomationReplyHandoff
                && isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext(request.authorization);
            const isServerOriginSessionServerStart = isReservedSessionServerStart
                && isSocketRpcSessionServerStartServerOriginAuthorizationContext(request.authorization);
            const isServerOriginActionApi = isReservedActionApi
                && isSocketRpcActionApiServerOriginAuthorizationContext(request.authorization);
            const isServerOriginReservedRequest = isServerOriginAutomationReplyHandoff
                || isServerOriginSessionServerStart
                || isServerOriginActionApi;
            if (isReservedServerOriginRequest && !isServerOriginReservedRequest) {
                return this.encodeTransportResponse(request, {
                    error: RPC_ERROR_MESSAGES.FORBIDDEN,
                    errorCode: RPC_ERROR_CODES.FORBIDDEN,
                });
            }

            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                return this.encodeTransportResponse(request, errorResponse);
            }

            // Decrypt the incoming params (unless session is plaintext).
            const decryptedParams = isServerOriginReservedRequest || this.transport.mode === 'plain'
              ? request.params
              : typeof request.params === 'string'
                ? decrypt(
                    this.transport.encryptionKey,
                    this.transport.encryptionVariant,
                    decodeBase64(request.params),
                )
                : null;
            if (
                !isServerOriginReservedRequest
                && this.transport.mode !== 'plain'
                && decryptedParams === null
            ) {
              const errorResponse = {
                error: 'Invalid RPC params',
              };
              return this.encodeTransportResponse(request, errorResponse);
            }

            if (this.authorizeRequest) {
                const authorization = await this.authorizeRequest({
                    method: request.method,
                    params: decryptedParams,
                    authorization: request.authorization,
                    transportResponseEnvelopeVersion: request.transportResponseEnvelopeVersion,
                });
                if (!authorization.ok) {
                    return this.encodeTransportResponse(request, {
                        error: authorization.error,
                        ...(authorization.errorCode ? { errorCode: authorization.errorCode } : {}),
                    });
                }
            }

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            handlerExecutionId = this.beginHandlerExecution(
                this.readUnprefixedMethod(request.method),
            );
            const result = await handler(decryptedParams, Object.freeze({
                signal: controller.signal,
                ...(request.authorization ? { authorization: request.authorization } : {}),
            }));
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const acknowledgement = this.projectAcknowledgement(
                request,
                decryptedParams,
                result,
            );
            const response = this.encodeTransportResponse(request, result, acknowledgement);
            if (this.transport.mode !== 'plain') {
                const encodedResult = request.transportResponseEnvelopeVersion
                    === SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1
                    && response
                    && typeof response === 'object'
                    && !Array.isArray(response)
                    ? (response as { result?: unknown }).result
                    : response;
                this.logger('[RPC] Sending encrypted response', {
                    method: request.method,
                    responseLength: typeof encodedResult === 'string' ? encodedResult.length : 0,
                });
            }
            return response;
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', {
                error: error instanceof Error
                    ? {
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                    }
                    : error,
            });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return this.encodeTransportResponse(request, errorResponse);
        } finally {
            if (handlerExecutionId !== null) {
                this.activeHandlerExecutions.delete(handlerExecutionId);
            }
            if (timeout) clearTimeout(timeout);
            this.activeTransportRequestControllers.delete(controller);
            if (requestId && this.activeTransportRequestControllersByRequestId.get(requestId) === controller) {
                this.activeTransportRequestControllersByRequestId.delete(requestId);
            }
            this.finishInFlightRequest();
        }
    }

    /**
     * Invoke a registered handler in-process (no encryption/decryption).
     *
     * This is intended for internal control-plane surfaces (e.g. MCP tools) that
     * must delegate to the same handler implementations as session RPC.
     */
    async invokeLocal(method: string, params: unknown, options?: Readonly<{
        signal?: AbortSignal;
        localActionContext?: import('./types').RpcLocalActionContext;
    }>): Promise<unknown> {
        const prefixedMethod = this.getPrefixedMethod(method);
        const handler = this.handlers.get(prefixedMethod);
        if (!handler) {
            return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        this.beginInFlightRequest();
        const handlerExecutionId = this.beginHandlerExecution(method);
        try {
            return await handler(params as any, Object.freeze({
                signal: options?.signal ?? new AbortController().signal,
                ...(options?.localActionContext
                    ? { localActionContext: options.localActionContext }
                    : {}),
            }));
        } finally {
            this.activeHandlerExecutions.delete(handlerExecutionId);
            this.finishInFlightRequest();
        }
    }

    onSocketConnect(socket: Socket): void {
        if (this.socket && this.socket !== socket) {
            this.settleRegistrationReadinessWaiters('disconnected');
        }
        this.socket = socket;
        this.acknowledgedRegistrationMethods.clear();
        socket.on(SOCKET_RPC_EVENTS.ERROR, (error: unknown) => {
            if (this.socket !== socket) {
                return;
            }
            const type = error && typeof error === 'object' && !Array.isArray(error)
                ? (error as Record<string, unknown>).type
                : null;
            if (type !== 'register') {
                return;
            }
            this.logger('[RPC] [ERROR] Handler registration rejected', { error });
            this.onRegistrationError?.(error);
        });
        socket.on(SOCKET_RPC_EVENTS.REGISTERED, (data: unknown) => {
            if (this.socket !== socket) {
                return;
            }
            const method = data && typeof data === 'object' && !Array.isArray(data)
                ? (data as Record<string, unknown>).method
                : null;
            if (typeof method !== 'string' || !this.handlers.has(method)) {
                return;
            }
            this.acknowledgedRegistrationMethods.add(method);
            this.settleReadyRegistrationWaiters();
            this.onRegistrationAcknowledged?.(method);
        });
        socket.on(SOCKET_RPC_EVENTS.CANCEL, (payload: unknown) => {
            if (this.socket !== socket) {
                return;
            }
            const parsed = SocketRpcCancellationPayloadSchema.safeParse(payload);
            if (!parsed.success) {
                return;
            }
            this.activeTransportRequestControllersByRequestId
                .get(parsed.data.requestId)
                ?.abort(new Error('RPC request cancelled by caller'));
        });
        for (const [prefixedMethod] of this.handlers) {
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
        this.acknowledgedRegistrationMethods.clear();
        this.settleRegistrationReadinessWaiters('disconnected');
        for (const controller of this.activeTransportRequestControllers) {
            controller.abort(new Error('RPC target transport disconnected'));
        }
        this.activeTransportRequestControllersByRequestId.clear();
    }

    async waitForRegisteredHandlers(
        methods: readonly string[],
        options: Readonly<{ timeoutMs: number }>,
    ): Promise<RpcHandlerRegistrationReadiness> {
        const requiredMethods = Array.from(new Set(methods.map((method) => method.trim()).filter(Boolean)));
        const requiredPrefixedMethods = new Set(requiredMethods.map((method) => this.getPrefixedMethod(method)));
        if (this.areRegistrationMethodsAcknowledged(requiredPrefixedMethods)) {
            return { status: 'ready' };
        }
        if (!this.socket) {
            return {
                status: 'disconnected',
                missingMethods: this.readMissingRegistrationMethods(requiredMethods),
            };
        }

        return await new Promise<RpcHandlerRegistrationReadiness>((resolve) => {
            let waiter!: RegistrationReadinessWaiter;
            const timeout = setTimeout(() => {
                this.registrationReadinessWaiters.delete(waiter);
                resolve({
                    status: 'timeout',
                    missingMethods: this.readMissingRegistrationMethods(requiredMethods),
                });
            }, Math.max(0, options.timeoutMs));
            waiter = {
                requiredMethods,
                requiredPrefixedMethods,
                resolve,
                timeout,
            };
            this.registrationReadinessWaiters.add(waiter);
            this.settleReadyRegistrationWaiters();
        });
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    getInFlightRequestCount(): number {
        return this.inFlightRequestCount;
    }

    getActiveHandlerExecutions(): readonly RpcHandlerActiveExecution[] {
        const observedAtMs = this.nowMs();
        return Array.from(this.activeHandlerExecutions.values(), (execution) => ({
            method: execution.method,
            activeForMs: Math.max(0, Math.round(observedAtMs - execution.startedAtMs)),
        }));
    }

    async waitForIdle(): Promise<void> {
        if (this.inFlightRequestCount === 0) {
            return;
        }
        await new Promise<void>((resolve) => {
            this.idleResolvers.add(resolve);
        });
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const ownedRegistration = this.ownedHandlerRegistration;
        if (ownedRegistration) {
            if (ownedRegistration.nextMethods.has(method)) {
                return true;
            }
            if (ownedRegistration.previousMethods.has(method)) {
                return false;
            }
        }
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    unregisterHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        const removed = this.handlers.delete(prefixedMethod);
        if (!removed) {
            return false;
        }
        for (const methods of this.ownedHandlerMethodsByOwner.values()) {
            methods.delete(method);
        }
        if (this.socket) {
            this.acknowledgedRegistrationMethods.delete(prefixedMethod);
            this.socket.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method: prefixedMethod });
        }
        return true;
    }

    replaceOwnedHandlers<T>(ownerId: string, register: () => T): T {
        const normalizedOwnerId = ownerId.trim();
        if (!normalizedOwnerId) {
            throw new Error('RPC handler owner id is required');
        }
        if (this.ownedHandlerRegistration) {
            throw new Error(`Nested RPC handler replacement is not supported: ${normalizedOwnerId}`);
        }

        const previousMethods = new Set(this.ownedHandlerMethodsByOwner.get(normalizedOwnerId) ?? []);
        const previousHandlers = new Map<string, RpcHandler>();
        for (const method of previousMethods) {
            const handler = this.handlers.get(this.getPrefixedMethod(method));
            if (handler) {
                previousHandlers.set(method, handler);
            }
        }
        const context: OwnedHandlerRegistrationContext = {
            ownerId: normalizedOwnerId,
            previousMethods,
            nextMethods: new Set(),
        };
        this.ownedHandlerRegistration = context;

        try {
            const result = register();
            this.ownedHandlerMethodsByOwner.set(normalizedOwnerId, context.nextMethods);
            for (const staleMethod of previousMethods) {
                if (!context.nextMethods.has(staleMethod)) {
                    this.unregisterHandler(staleMethod);
                }
            }
            return result;
        } catch (error) {
            for (const nextMethod of context.nextMethods) {
                if (!previousMethods.has(nextMethod)) {
                    this.unregisterHandler(nextMethod);
                }
            }
            for (const [method, handler] of previousHandlers) {
                this.handlers.set(this.getPrefixedMethod(method), handler);
            }
            this.ownedHandlerMethodsByOwner.set(normalizedOwnerId, previousMethods);
            throw error;
        } finally {
            this.ownedHandlerRegistration = null;
        }
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.acknowledgedRegistrationMethods.clear();
        this.ownedHandlerMethodsByOwner.clear();
        this.logger('Cleared all RPC handlers');
    }

    private encodeResponse(request: RpcRequest, response: unknown): unknown {
        if (
            this.transport.mode === 'plain'
            || this.isServerOriginReservedRequest(request)
        ) {
            return response;
        }
        return encodeBase64(encrypt(
            this.transport.encryptionKey,
            this.transport.encryptionVariant,
            response,
        ));
    }

    private encodeTransportResponse(
        request: RpcRequest,
        result: unknown,
        acknowledgement: SocketRpcTransportAcknowledgementV1 | null = null,
    ): unknown {
        const encodedResult = this.encodeResponse(request, result);
        if (
            request.transportResponseEnvelopeVersion
            !== SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1
        ) {
            return encodedResult;
        }
        return {
            v: SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
            result: encodedResult,
            ...(acknowledgement ? { acknowledgement } : {}),
        };
    }

    private projectAcknowledgement(
        request: RpcRequest,
        params: unknown,
        result: unknown,
    ): SocketRpcTransportAcknowledgementV1 | null {
        if (
            request.transportResponseEnvelopeVersion
            !== SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1
            || !this.projectTransportAcknowledgement
        ) {
            return null;
        }
        try {
            return this.projectTransportAcknowledgement({
                method: request.method,
                params,
                result,
                ...(request.authorization
                    ? { authorization: request.authorization }
                    : {}),
            });
        } catch (error) {
            this.logger('[RPC] Transport acknowledgement projection failed', {
                method: request.method,
                error,
            });
            return null;
        }
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }

    private readUnprefixedMethod(method: string): string {
        const prefix = `${this.scopePrefix}:`;
        return method.startsWith(prefix) ? method.slice(prefix.length) : method;
    }

    private beginHandlerExecution(method: string): number {
        const id = this.nextHandlerExecutionId;
        this.nextHandlerExecutionId += 1;
        this.activeHandlerExecutions.set(id, {
            method,
            startedAtMs: this.nowMs(),
        });
        return id;
    }

    private isReservedAutomationReplyHandoffRequest(request: RpcRequest): boolean {
        return request.method === this.getPrefixedMethod(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    }

    private isServerOriginAutomationReplyHandoffRequest(request: RpcRequest): boolean {
        return this.isReservedAutomationReplyHandoffRequest(request)
            && isSocketRpcAutomationReplyHandoffServerOriginAuthorizationContext(request.authorization);
    }

    private isReservedSessionServerStartRequest(request: RpcRequest): boolean {
        return request.method === this.getPrefixedMethod(SESSION_SERVER_START_DAEMON_RPC_METHOD_V1);
    }

    private isServerOriginSessionServerStartRequest(request: RpcRequest): boolean {
        return this.isReservedSessionServerStartRequest(request)
            && isSocketRpcSessionServerStartServerOriginAuthorizationContext(request.authorization);
    }

    private isReservedActionApiRequest(request: RpcRequest): boolean {
        return request.method === this.getPrefixedMethod(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1);
    }

    private isServerOriginActionApiRequest(request: RpcRequest): boolean {
        return this.isReservedActionApiRequest(request)
            && isSocketRpcActionApiServerOriginAuthorizationContext(request.authorization);
    }

    private isServerOriginReservedRequest(request: RpcRequest): boolean {
        return this.isServerOriginAutomationReplyHandoffRequest(request)
            || this.isServerOriginSessionServerStartRequest(request)
            || this.isServerOriginActionApiRequest(request);
    }

    private areRegistrationMethodsAcknowledged(methods: ReadonlySet<string>): boolean {
        for (const method of methods) {
            if (!this.acknowledgedRegistrationMethods.has(method)) {
                return false;
            }
        }
        return true;
    }

    private readMissingRegistrationMethods(methods: readonly string[]): readonly string[] {
        return methods.filter((method) => (
            !this.acknowledgedRegistrationMethods.has(this.getPrefixedMethod(method))
        ));
    }

    private settleReadyRegistrationWaiters(): void {
        for (const waiter of Array.from(this.registrationReadinessWaiters)) {
            if (!this.areRegistrationMethodsAcknowledged(waiter.requiredPrefixedMethods)) {
                continue;
            }
            this.registrationReadinessWaiters.delete(waiter);
            clearTimeout(waiter.timeout);
            waiter.resolve({ status: 'ready' });
        }
    }

    private settleRegistrationReadinessWaiters(status: 'disconnected'): void {
        for (const waiter of Array.from(this.registrationReadinessWaiters)) {
            this.registrationReadinessWaiters.delete(waiter);
            clearTimeout(waiter.timeout);
            waiter.resolve({
                status,
                missingMethods: this.readMissingRegistrationMethods(waiter.requiredMethods),
            });
        }
    }

    private beginInFlightRequest(): void {
        this.inFlightRequestCount += 1;
    }

    private finishInFlightRequest(): void {
        this.inFlightRequestCount = Math.max(0, this.inFlightRequestCount - 1);
        if (this.inFlightRequestCount === 0 && this.idleResolvers.size > 0) {
            const resolvers = Array.from(this.idleResolvers);
            this.idleResolvers.clear();
            for (const resolve of resolvers) {
                resolve();
            }
        }
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
