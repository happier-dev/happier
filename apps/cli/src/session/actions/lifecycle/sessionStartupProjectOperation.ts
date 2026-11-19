import { SPAWN_SESSION_ERROR_CODES, projectDaemonSpawnUnavailable } from '@/session/shared/spawnSessionContract';
import { SessionStartupInputRefusalError } from '@/agent/runtime/session/input/sessionStartupInputRefusal';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { logger } from '@/ui/logger';
import type { ExactTrackedRunnerStopWitness } from '@/daemon/sessions/stopSession';
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
    const authorization = context?.callerInputAuthorization ?? local?.externalActionExecutionAuthorization;
    const operation: ProjectSetupOperationContext | undefined = context?.signal && local?.operationAcceptance
        && local.operationProgress && local.operationOwnerUpdate && local.operationReview
        ? { signal: context.signal, actionRequestId: local.actionRequestId ?? undefined,
            operationProgress: local.operationProgress, operationOwnerUpdate: local.operationOwnerUpdate,
            operationAcceptance: local.operationAcceptance, operationReview: local.operationReview,
            ...(local.setupAutostart ? { setupAutostart: local.setupAutostart } : {}),
            ...(authorization ? { externalActionExecutionAuthorization: authorization,
                externalActionTarget: authorization.binding.target } : {}),
            ...(local.operationCancellation ? { operationCancellation: local.operationCancellation } : {}),
            ...(local.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: local.requesterWorkAttributionV1 } : {}) }
        : undefined;
    const retireRefusedRunner = async (sessionId: string, expectedTrackedRunner: ExactTrackedRunnerStopWitness) => {
        try {
            const stopped = await input.stopSession!(sessionId, { expectedTrackedRunner });
            if (stopped !== true && (typeof stopped === 'boolean' || stopped.status !== 'stopped')) {
                logger.infoFile('[SESSION STARTUP] Refused runner retirement incomplete', { sessionId, stopResult: stopped });
            }
        } catch {
            logger.infoFile('[SESSION STARTUP] Refused runner retirement failed', { sessionId });
        }
    };
    return async options => {
        // Webhook acknowledgement and native open consume one startup budget.
        // Resume has no fresh-creation operation, but a webhook still does not
        // prove that native authentication and Session construction succeeded.
        const observeNativeOpen = Boolean(operation || (options.existingSessionId && !options.freshSessionCreation));
        const startupDeadline = observeNativeOpen ? Date.now() + resolveSessionStartupTimeoutMs() : null;
        if (observeNativeOpen && (!input.awaitAgentSessionOpen || !input.stopSession)) {
            return projectDaemonSpawnUnavailable('session_startup_observation_unavailable', 'Session native startup observation or retirement unavailable');
        }
        const spawnOptions = operation ? { ...options, projectSetupOperation: operation } : options;
        const result = context?.signal
            ? await input.spawnSession(spawnOptions, context.signal)
            : await input.spawnSession(spawnOptions);
        if (result.type !== 'success' || !result.sessionId || !observeNativeOpen) return result;
        // The native-fork owner awaits this same attestation inside its child
        // cleanup scope. Keep its physical child id available before refusal.
        if (options.nativeForkSource) return result;
        // Runner-created Sessions first prove their committed id at the webhook.
        // Daemon-committed launches already offered the same acceptance after attach.
        // In either case the original operation retains native/input custody.
        if (operation?.operationAcceptance?.actionId === 'session.spawn_new') {
            operation.operationAcceptance.accept({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted', sessionId: result.sessionId });
        }
        const opened = await input.awaitAgentSessionOpen!({ sessionId: result.sessionId,
            timeoutMs: Math.max(0, startupDeadline! - Date.now()), signal: context?.signal });
        context?.signal?.throwIfAborted();
        // A native-mode refusal remains terminal after row commitment;
        // creation reconciliation must not reinterpret it as success.
        if (opened.status === 'refused') {
            // This operation spawned the refused runner and has not offered its
            // original input. Retire it through the daemon's normal Stop owner,
            // which also suppresses respawn, before releasing startup custody.
            // Native-fork children retain their existing fork cleanup scope above.
            await retireRefusedRunner(result.sessionId, opened.expectedTrackedRunner);
            throw new SessionStartupInputRefusalError({ code: opened.code,
                message: 'The selected native Agent mode is not available in this Session.' });
        }
        if (opened.status === 'timeout') {
            const message = 'Agent native Session startup did not complete within the configured startup budget';
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: message,
                errorDetail: { kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT, message } };
        }
        if (opened.status !== 'opened') {
            const code = opened.status === 'construction_failed' ? opened.failure.code : opened.code;
            const failureCause = opened.status === 'construction_failed' ? opened.failure.failureCause : opened.failureCause;
            const agentId = code === 'agent_cli_not_runnable' && options.backendTarget?.kind === 'backend'
                ? options.backendTarget.backendId : undefined;
            const message = readSessionStartupFailurePreview(code, agentId ? resolveAgentDisplayTitle(agentId) : null,
                failureCause)
                ?? (opened.status === 'construction_failed'
                    ? 'Agent native Session construction failed'
                    : 'Agent runner exited before native Session startup completed');
            const failure = { type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: message,
                ...(agentId ? { agentId } : {}),
                errorDetail: { kind: 'launch_error' as const, code: code ?? SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, message,
                    ...(failureCause ? { failureCause } : {}) } };
            // The committed birth can accept input even though native open is
            // waiting on its broker. Message admission retains that input;
            // the existing Pending activation owner owns subsequent launches.
            if (operation?.operationAcceptance?.actionId === 'session.spawn_new'
                && isSessionSpawnBrokerUnavailable(failure)) return result;
            if (opened.status === 'construction_failed') {
                await retireRefusedRunner(result.sessionId, opened.expectedTrackedRunner);
            }
            return failure;
        }
        return result;
    };
}
