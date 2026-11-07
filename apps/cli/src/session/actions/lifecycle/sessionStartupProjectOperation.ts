import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { SessionStartupInputRefusalError } from '@/agent/runtime/session/input/sessionStartupInputRefusal';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { logger } from '@/ui/logger';
import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { isSessionSpawnBrokerUnavailable } from '@happier-dev/protocol/spawnSession';

import type { SessionLifecycleActionHandler, SessionLifecycleMachineDeps, SessionLifecycleMachineHandlers } from './sessionLifecycleTypes';

/** Keep the original operation live until the tracked-runner owner observes native open or refusal. */
export function createSessionStartupProjectSpawn(input: Readonly<{
    context: Parameters<SessionLifecycleActionHandler>[1];
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
    stopSession?: SessionLifecycleMachineHandlers['stopSession'];
    awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
}>): SessionLifecycleMachineHandlers['spawnSession'] {
    const context = input.context;
    const local = context?.localActionContext;
    const operation: ProjectSetupOperationContext | undefined = context?.signal && local?.operationAcceptance
        && local.operationProgress && local.operationOwnerUpdate && local.operationReview
        ? { signal: context.signal, actionRequestId: local.actionRequestId ?? undefined,
            operationProgress: local.operationProgress, operationOwnerUpdate: local.operationOwnerUpdate,
            operationAcceptance: local.operationAcceptance, operationReview: local.operationReview,
            ...(local.operationCancellation ? { operationCancellation: local.operationCancellation } : {}),
            ...(local.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: local.requesterWorkAttributionV1 } : {}) }
        : undefined;
    return async options => {
        // Webhook acknowledgement and native open consume one startup budget.
        const startupDeadline = operation ? Date.now() + resolveSessionStartupTimeoutMs() : null;
        if (operation && (!input.awaitAgentSessionOpen || !input.stopSession)) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Session native startup observation or retirement unavailable' };
        }
        const result = await input.spawnSession({ ...options, ...(operation ? { projectSetupOperation: operation } : {}) });
        if (result.type !== 'success' || !result.sessionId || !operation) return result;
        // The native-fork owner awaits this same attestation inside its child
        // cleanup scope. Keep its physical child id available before refusal.
        if (options.nativeForkSource) return result;
        // Runner-created Sessions first prove their committed id at the webhook.
        // Daemon-committed launches already offered the same acceptance after attach.
        // In either case the original operation retains native/input custody.
        if (operation.operationAcceptance?.actionId === 'session.spawn_new') {
            operation.operationAcceptance.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', sessionId: result.sessionId });
        }
        const opened = await input.awaitAgentSessionOpen!({ sessionId: result.sessionId,
            timeoutMs: Math.max(0, startupDeadline! - Date.now()), signal: operation.signal });
        operation.signal.throwIfAborted();
        // A native-mode refusal remains terminal after row commitment;
        // creation reconciliation must not reinterpret it as success.
        if (opened.status === 'refused') {
            // This operation spawned the refused runner and has not offered its
            // original input. Retire it through the daemon's normal Stop owner,
            // which also suppresses respawn, before releasing startup custody.
            // Native-fork children retain their existing fork cleanup scope above.
            try {
                const stopped = await input.stopSession!(result.sessionId, {
                    expectedTrackedRunner: opened.expectedTrackedRunner,
                });
                if (stopped !== true && (typeof stopped === 'boolean' || stopped.status !== 'stopped')) {
                    logger.infoFile('[SESSION STARTUP] Refused runner retirement incomplete', {
                        sessionId: result.sessionId, stopResult: stopped,
                    });
                }
            } catch {
                logger.infoFile('[SESSION STARTUP] Refused runner retirement failed', { sessionId: result.sessionId });
            }
            throw new SessionStartupInputRefusalError({ code: opened.code,
                message: 'The selected native Agent mode is not available in this Session.' });
        }
        if (opened.status === 'timeout') {
            const message = 'Agent native Session startup did not complete within the configured startup budget';
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: message,
                errorDetail: { kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT, message } };
        }
        if (opened.status !== 'opened') {
            const code = opened.status === 'runner_exited' ? opened.code : undefined;
            const agentId = code === 'agent_cli_not_runnable' && options.backendTarget?.kind === 'backend'
                ? options.backendTarget.backendId : undefined;
            const message = readSessionStartupFailurePreview(code, agentId ? resolveAgentDisplayTitle(agentId) : null)
                ?? 'Agent runner exited before native Session startup completed';
            const failure = { type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: message,
                ...(agentId ? { agentId } : {}),
                errorDetail: { kind: 'launch_error' as const, code: code ?? SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, message,
                    ...(opened.status === 'runner_exited' && opened.failureCause ? { failureCause: opened.failureCause } : {}) } };
            // The committed birth can accept input even though native open is
            // waiting on its broker. Message admission retains that input;
            // the existing Pending activation owner owns subsequent launches.
            if (operation.operationAcceptance?.actionId === 'session.spawn_new'
                && isSessionSpawnBrokerUnavailable(failure)) return result;
            return failure;
        }
        return result;
    };
}
