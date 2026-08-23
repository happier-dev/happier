import type { RpcActionExecutor } from './_actionDispatchAdapter';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { readStoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
    type ActionSpecRpcRegistrationScope,
    SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
    SESSION_LIFECYCLE_RPC_SCOPES,
    SESSION_SPAWN_NEW_RPC_SCOPES,
} from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers, type RegisterActionSpecRpcHandlersParams } from './registerActionSpecRpcHandlers';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    awaitSpawnedSessionId,
    type SpawnSessionNonceResolver,
} from '@/session/services/awaitSpawnedSessionId';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { SpawnDaemonSessionRequestSchema } from './spawnSessionOptionsContract';
import type { SessionLifecycleActionHandler } from '@/session/actions/lifecycle/sessionLifecycleTypes';

type RpcRegistrar = RpcHandlerRegistrar;

type SessionLifecycleActionId =
    | 'session.stop'
    | 'session.fork'
    | 'session.continue_with_replay'
    | 'session.rollback'
    | 'session.checkpoint_code_rollback'
    | 'session.checkpoint'
    | 'session.restore'
    | 'session.handoff'
    | 'session.handoff.prepare_target'
    | 'session.handoff.prepare_target.resume'
    | 'session.handoff.prepare_target_result.get'
    | 'session.handoff.commit'
    | 'session.handoff.abort'
    | 'session.handoff.status.get';

export type SessionLifecycleActionHandlers = Partial<Record<
    SessionLifecycleActionId,
    (input: unknown, context?: RpcHandlerContext) => Promise<unknown>
>>;
export { SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES };

export function createSessionLifecycleRpcActionExecutor(
    handlers: SessionLifecycleActionHandlers,
): RpcActionExecutor {
    return {
        execute: async (actionId, input, context) => {
            const handler = handlers[actionId as SessionLifecycleActionId];
            if (!handler) {
                return {
                    ok: false,
                    errorCode: 'unsupported_action',
                    error: `unsupported_action:${actionId}`,
                };
            }
            return {
                ok: true,
                result: await handler(input, context
                    ? {
                        signal: context.signal ?? new AbortController().signal,
                        ...(context.operationProgress || context.operationOwnerUpdate
                            ? {
                                localActionContext: {
                                    ...(context.operationProgress
                                        ? { operationProgress: context.operationProgress }
                                        : {}),
                                    ...(context.operationOwnerUpdate
                                        ? { operationOwnerUpdate: context.operationOwnerUpdate }
                                        : {}),
                                },
                            }
                            : {}),
                    }
                    : undefined),
            };
        },
    };
}

export function registerSessionLifecycleRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor: RpcActionExecutor;
    actionIds?: readonly SessionLifecycleActionId[];
    scopes?: readonly ActionSpecRpcRegistrationScope[];
    observeExecution?: RegisterActionSpecRpcHandlersParams['observeExecution'];
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        actionExecutor: params.actionExecutor,
        actionIds: params.actionIds,
        scopes: params.scopes ?? SESSION_LIFECYCLE_RPC_SCOPES,
        ...(params.observeExecution ? { observeExecution: params.observeExecution } : {}),
    });
}

async function resolveProductionSessionSpawnNewActionExecutor(): Promise<RpcActionExecutor> {
    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return {
            execute: async () => ({
                ok: false,
                errorCode: 'not_authenticated',
                error: 'not_authenticated',
            }),
        };
    }
    return createCliActionExecutorFromCredentials({ credentials });
}

/**
 * Registers the public Action transport alongside, but never through, the
 * private daemon Session-lifecycle spawn transport below.
 */
export function registerSessionSpawnNewRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor?: RpcActionExecutor;
    observeExecution?: RegisterActionSpecRpcHandlersParams['observeExecution'];
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        actionExecutor: params.actionExecutor,
        resolveActionExecutor: resolveProductionSessionSpawnNewActionExecutor,
        scopes: SESSION_SPAWN_NEW_RPC_SCOPES,
        ...(params.observeExecution ? { observeExecution: params.observeExecution } : {}),
    });
}

/**
 * Private machine transport owner for the pre-Action Session lifecycle RPCs.
 * This transport has its own request vocabulary and lifecycle contract; it
 * must never project raw machine payloads into the public session.spawn_new
 * Action schema.
 */
export function registerPrivateSpawnSessionRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    spawnLifecycleHandler: SessionLifecycleActionHandler;
    resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
    /**
     * The advertised Session-spawn V1 owner must return the authoritative
     * create-or-rejoin fact with every resolved Session id.
     */
    requireSessionCreationOutcome?: boolean;
}>): void {
    const settlePrimaryFreshSpawn = async (response: unknown): Promise<unknown> => {
        if (!response || typeof response !== 'object' || (response as { type?: unknown }).type !== 'success') {
            return response;
        }
        const sessionId = typeof (response as { sessionId?: unknown }).sessionId === 'string'
            ? (response as { sessionId: string }).sessionId.trim()
            : '';
        if (sessionId) {
            const normalized = normalizeSpawnSessionNonceResolution({
                status: 'success',
                sessionId,
                sessionCreationOutcome: (response as { sessionCreationOutcome?: unknown })
                    .sessionCreationOutcome,
            });
            if (
                params.requireSessionCreationOutcome === true
                && (
                    normalized.status !== 'success'
                    || !normalized.sessionCreationOutcome
                )
            ) {
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                    errorMessage: 'Advertised session-spawn V1 did not return create-or-rejoin outcome',
                };
            }
            return {
                type: 'success',
                sessionId,
                ...(normalized.status === 'success' && normalized.sessionCreationOutcome
                    ? { sessionCreationOutcome: normalized.sessionCreationOutcome }
                    : {}),
            };
        }
        const spawnNonce = typeof (response as { spawnNonce?: unknown }).spawnNonce === 'string'
            ? (response as { spawnNonce: string }).spawnNonce.trim()
            : '';
        if (!spawnNonce || !params.resolveSpawnSessionByNonce) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Spawn succeeded without a resolvable session identity',
            };
        }
        const settled = await awaitSpawnedSessionId({
            result: response,
            spawnNonce,
            resolveSpawnSessionByNonce: params.resolveSpawnSessionByNonce,
        });
        if (
            params.requireSessionCreationOutcome === true
            && settled.type === 'success'
            && !settled.sessionCreationOutcome
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Advertised session-spawn V1 did not return create-or-rejoin outcome',
            };
        }
        return settled;
    };

    const handle = async (
        input: unknown,
        providerSafe: boolean,
        context?: RpcHandlerContext,
    ): Promise<unknown> => {
        const parsed = SpawnDaemonSessionRequestSchema.safeParse(input);
        if (!parsed.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid session spawn request',
            };
        }
        const response = await params.spawnLifecycleHandler(parsed.data, context);
        // Inactive resume deliberately reports a bare success envelope. It is
        // a different lifecycle operation, not an unresolvable fresh spawn.
        if (providerSafe || parsed.data.type === 'resume-session') {
            return response;
        }
        return await settlePrimaryFreshSpawn(response);
    };

    params.rpcHandlerManager.registerHandler(
        RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
        async (input, context) => await handle(input, true, context),
    );
    params.rpcHandlerManager.registerHandler(
        RPC_METHODS.SPAWN_HAPPY_SESSION,
        async (input, context) => await handle(input, false, context),
    );
}
