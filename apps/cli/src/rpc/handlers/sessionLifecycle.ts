import type { RpcActionExecutor } from './_actionDispatchAdapter';
import {
    type ActionSpecRpcRegistrationScope,
    SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
    SESSION_LIFECYCLE_RPC_SCOPES,
} from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

type RpcRegistrar = Readonly<{
    registerHandler(method: string, handler: (input: unknown) => Promise<unknown>): void;
}>;

type SessionLifecycleActionId =
    | 'session.spawn_new'
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

export type SessionLifecycleActionHandlers = Partial<Record<SessionLifecycleActionId, (input: unknown) => Promise<unknown>>>;
export { SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES };

export function createSessionLifecycleRpcActionExecutor(
    handlers: SessionLifecycleActionHandlers,
): RpcActionExecutor {
    return {
        execute: async (actionId, input) => {
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
                result: await handler(input),
            };
        },
    };
}

export function registerSessionLifecycleRpcHandlers(params: Readonly<{
    rpcHandlerManager: RpcRegistrar;
    actionExecutor: RpcActionExecutor;
    actionIds?: readonly SessionLifecycleActionId[];
    scopes?: readonly ActionSpecRpcRegistrationScope[];
}>): void {
    registerActionSpecRpcHandlers({
        rpcHandlerManager: params.rpcHandlerManager,
        actionExecutor: params.actionExecutor,
        actionIds: params.actionIds,
        scopes: params.scopes ?? SESSION_LIFECYCLE_RPC_SCOPES,
    });
}
