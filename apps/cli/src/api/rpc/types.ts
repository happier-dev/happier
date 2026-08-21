import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol';
import type {
    SocketRpcRequestPayload,
    SocketRpcTransportAcknowledgementV1,
} from '@happier-dev/protocol/socketRpc';

/**
 * Common RPC types and interfaces for both session and machine clients
 */

/**
 * Generic RPC handler function type
 * @template TRequest - The request data type
 * @template TResponse - The response data type
 */
export type RpcHandler<TRequest = any, TResponse = any> = (
    data: TRequest
) => TResponse | Promise<TResponse>;

export type RpcHandlerRegistrar = Readonly<{
    registerHandler: <TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>,
    ) => void;
}>;

export type RpcHandlerInvoker = Readonly<{
    invokeLocal: (method: string, params: unknown) => Promise<unknown>;
}>;

export type RpcHandlerManagerLike = RpcHandlerRegistrar & RpcHandlerInvoker;

/**
 * Map of method names to their handlers
 */
export type RpcHandlerMap = Map<string, RpcHandler>;

/**
 * RPC request data from server
 */
export type RpcRequest = SocketRpcRequestPayload;

/**
 * RPC response callback
 */
export type RpcResponseCallback = (response: unknown) => void;

/**
 * Configuration for RPC handler manager
 */
export interface RpcHandlerConfig {
    scopePrefix: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    encryptionMode?: 'e2ee' | 'plain';
    logger?: (message: string, data?: any) => void;
    onRegistrationError?: (error: unknown) => void;
    onRegistrationAcknowledged?: (method: string) => void;
    nowMs?: () => number;
    authorizeRequest?: (request: Readonly<{
        method: string;
        params: unknown;
        authorization?: SocketRpcAuthorizationContext;
        transportResponseEnvelopeVersion?: 1;
    }>) => RpcAuthorizationResult | Promise<RpcAuthorizationResult>;
    projectTransportAcknowledgement?: (request: Readonly<{
        method: string;
        params: unknown;
        result: unknown;
        authorization?: SocketRpcAuthorizationContext;
    }>) => SocketRpcTransportAcknowledgementV1 | null;
}

export type RpcHandlerActiveExecution = Readonly<{
    method: string;
    activeForMs: number;
}>;

export type RpcAuthorizationResult =
    | { ok: true }
    | { ok: false; error: string; errorCode?: string };

/**
 * Result of RPC handler execution
 */
export type RpcHandlerResult<T = any> =
    | { success: true; data: T }
    | { success: false; error: string };
