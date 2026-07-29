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
} from './types';
import { Socket } from 'socket.io-client';
import {
    SOCKET_RPC_EVENTS,
    SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
    type SocketRpcTransportAcknowledgementV1,
} from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

type OwnedHandlerRegistrationContext = {
    ownerId: string;
    previousMethods: ReadonlySet<string>;
    nextMethods: Set<string>;
};

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly encryptionMode: 'e2ee' | 'plain';
    private readonly authorizeRequest: RpcHandlerConfig['authorizeRequest'];
    private readonly projectTransportAcknowledgement:
        RpcHandlerConfig['projectTransportAcknowledgement'];
    private readonly logger: (message: string, data?: any) => void;
    private readonly onRegistrationError: RpcHandlerConfig['onRegistrationError'];
    private socket: Socket | null = null;
    private inFlightRequestCount = 0;
    private activeTransportRequestControllers = new Set<AbortController>();
    private idleResolvers = new Set<() => void>();
    private readonly ownedHandlerMethodsByOwner = new Map<string, Set<string>>();
    private ownedHandlerRegistration: OwnedHandlerRegistrationContext | null = null;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.encryptionMode = config.encryptionMode ?? 'e2ee';
        this.authorizeRequest = config.authorizeRequest;
        this.projectTransportAcknowledgement =
            config.projectTransportAcknowledgement;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
        this.onRegistrationError = config.onRegistrationError;
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
        this.beginInFlightRequest();
        const controller = new AbortController();
        this.activeTransportRequestControllers.add(controller);
        const timeoutMs = typeof request.timeoutMs === 'number'
            && Number.isSafeInteger(request.timeoutMs)
            && request.timeoutMs > 0
            ? request.timeoutMs
            : null;
        const timeout = timeoutMs === null
            ? null
            : setTimeout(() => controller.abort(new Error('RPC request timed out')), timeoutMs);
        try {
            const handler = this.handlers.get(request.method);

            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method });
                const errorResponse = { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                return this.encodeTransportResponse(request, errorResponse);
            }

            // Decrypt the incoming params (unless session is plaintext).
            const decryptedParams = this.encryptionMode === 'plain'
              ? request.params
              : typeof request.params === 'string'
                ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(request.params))
                : null;
            if (this.encryptionMode !== 'plain' && decryptedParams === null) {
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
            const result = await handler(decryptedParams, Object.freeze({ signal: controller.signal }));
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const acknowledgement = this.projectAcknowledgement(
                request,
                decryptedParams,
                result,
            );
            const response = this.encodeTransportResponse(request, result, acknowledgement);
            if (this.encryptionMode !== 'plain') {
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
            this.logger('[RPC] [ERROR] Error handling request', { error });
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return this.encodeTransportResponse(request, errorResponse);
        } finally {
            if (timeout) clearTimeout(timeout);
            this.activeTransportRequestControllers.delete(controller);
            this.finishInFlightRequest();
        }
    }

    /**
     * Invoke a registered handler in-process (no encryption/decryption).
     *
     * This is intended for internal control-plane surfaces (e.g. MCP tools) that
     * must delegate to the same handler implementations as session RPC.
     */
    async invokeLocal(method: string, params: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown> {
        const prefixedMethod = this.getPrefixedMethod(method);
        const handler = this.handlers.get(prefixedMethod);
        if (!handler) {
            return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        this.beginInFlightRequest();
        try {
            return await handler(params as any, Object.freeze({
                signal: options?.signal ?? new AbortController().signal,
            }));
        } finally {
            this.finishInFlightRequest();
        }
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket;
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
        for (const [prefixedMethod] of this.handlers) {
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
        for (const controller of this.activeTransportRequestControllers) {
            controller.abort(new Error('RPC target transport disconnected'));
        }
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
        this.ownedHandlerMethodsByOwner.clear();
        this.logger('Cleared all RPC handlers');
    }

    private encodeResponse(response: unknown): unknown {
        if (this.encryptionMode === 'plain') return response;
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, response));
    }

    private encodeTransportResponse(
        request: RpcRequest,
        result: unknown,
        acknowledgement: SocketRpcTransportAcknowledgementV1 | null = null,
    ): unknown {
        const encodedResult = this.encodeResponse(result);
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
