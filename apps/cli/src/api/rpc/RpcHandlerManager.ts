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
    type RpcAuthorizationResult,
} from './types';
import { Socket } from 'socket.io-client';
import {
    SOCKET_RPC_EVENTS,
    SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
    type SocketRpcTransportAcknowledgementV1,
} from '@happier-dev/protocol/socketRpc';
import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    isDelegatedSessionApprovalRpcMethod,
} from '@happier-dev/protocol/rpc';
import { isPublicRpcHandlerError, toSocketRpcTargetFailureV1 } from '@happier-dev/protocol/rpcErrors';

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
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly encryptionMode: 'e2ee' | 'plain';
    private readonly logger: (message: string, data?: any) => void;
    private readonly onRegistrationError: RpcHandlerConfig['onRegistrationError'];
    private readonly onRegistrationAcknowledged: RpcHandlerConfig['onRegistrationAcknowledged'];
    private readonly authorizeRequest: RpcHandlerConfig['authorizeRequest'];
    private readonly projectTransportAcknowledgement: RpcHandlerConfig['projectTransportAcknowledgement'];
    private readonly nowMs: () => number;
    private socket: Socket | null = null;
    private acknowledgedRegistrationMethods = new Set<string>();
    private registrationReadinessWaiters = new Set<RegistrationReadinessWaiter>();
    private inFlightRequestCount = 0;
    private idleResolvers = new Set<() => void>();
    private nextHandlerExecutionId = 1;
    private activeHandlerExecutions = new Map<number, Readonly<{
        method: string;
        startedAtMs: number;
    }>>();

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.encryptionMode = config.encryptionMode ?? 'e2ee';
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data));
        this.onRegistrationError = config.onRegistrationError;
        this.onRegistrationAcknowledged = config.onRegistrationAcknowledged;
        this.authorizeRequest = config.authorizeRequest;
        this.projectTransportAcknowledgement = config.projectTransportAcknowledgement;
        this.nowMs = config.nowMs ?? (() => performance.now());
    }

    private encodeResponse(response: unknown): unknown {
        if (this.encryptionMode === 'plain') return response;
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, response));
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
        this.beginInFlightRequest();
        let handlerExecutionId: number | null = null;
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

            const authorizationResult: RpcAuthorizationResult = this.authorizeRequest
              ? await this.authorizeRequest({
                method: request.method,
                params: decryptedParams,
                authorization: request.authorization,
                transportResponseEnvelopeVersion: request.transportResponseEnvelopeVersion,
              })
              : { ok: true };
            if (authorizationResult.ok !== true) {
              return this.encodeTransportResponse(request, {
                error: authorizationResult.error,
                ...(authorizationResult.errorCode ? { errorCode: authorizationResult.errorCode } : {}),
              });
            }

            // Call the handler
            this.logger('[RPC] Calling handler', { method: request.method });
            handlerExecutionId = this.beginHandlerExecution(this.readUnprefixedMethod(request.method));
            const result = await handler(decryptedParams);
            this.logger('[RPC] Handler returned', { method: request.method, hasResult: result !== undefined });

            // Encrypt and return the response
            const acknowledgement = this.projectAcknowledgement(request, decryptedParams, result);
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
            if (handlerExecutionId !== null) {
                this.activeHandlerExecutions.delete(handlerExecutionId);
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
    async invokeLocal(method: string, params: unknown): Promise<unknown> {
        const prefixedMethod = this.getPrefixedMethod(method);
        const handler = this.handlers.get(prefixedMethod);
        if (!handler) {
            return { error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }
        this.beginInFlightRequest();
        const handlerExecutionId = this.beginHandlerExecution(method);
        try {
            return await handler(params as any);
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
        for (const [prefixedMethod] of this.handlers) {
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
        this.acknowledgedRegistrationMethods.clear();
        this.settleRegistrationReadinessWaiters('disconnected');
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
     * Replay only registrations that the active server socket has not acknowledged.
     *
     * A daemon can connect while the server is still completing socket admission.
     * The machine lifecycle owns the bounded retry; this manager preserves the
     * active-socket receipt boundary and never replays acknowledged handlers.
     */
    replayUnacknowledgedHandlerRegistrations(methods: readonly string[]): readonly string[] {
        const socket = this.socket;
        if (!socket) return [];

        const replayedMethods: string[] = [];
        for (const method of new Set(methods.map((candidate) => candidate.trim()).filter(Boolean))) {
            const prefixedMethod = this.getPrefixedMethod(method);
            if (
                !this.handlers.has(prefixedMethod)
                || this.acknowledgedRegistrationMethods.has(prefixedMethod)
            ) {
                continue;
            }
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
            replayedMethods.push(method);
        }
        return replayedMethods;
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
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.acknowledgedRegistrationMethods.clear();
        this.logger('Cleared all RPC handlers');
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
                ...(request.authorization ? { authorization: request.authorization } : {}),
            });
        } catch (error) {
            this.logger('[RPC] Transport acknowledgement projection failed', {
                method: request.method,
                error,
            });
            return null;
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
