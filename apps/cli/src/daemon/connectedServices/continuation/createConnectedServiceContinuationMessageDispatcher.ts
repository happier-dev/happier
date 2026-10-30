import { createHash } from 'node:crypto';

import {
  readPendingLocalId,
  type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { logger } from '@/ui/logger';

import { buildContinuationResumePrompt } from './continuationResumePrompt';
import type { ConnectedServiceRuntimeAuthFailureKind } from '../runtimeAuth/types';
import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';

export type ConnectedServiceContinuationInterruption =
  | 'none'
  | 'clean_boundary'
  | 'forced_turn_cancelled'
  | 'provider_failed_turn';

type ConnectedServiceContinuationMessageDispatcherDeps = Readonly<{
  credentials: Credentials;
  sendMessage?: typeof sendSessionMessage;
}>;

export type RuntimeAuthRecoveryContinuationAdmission = Readonly<{
  armedAtMs: number;
  isCurrent: () => boolean;
  readActiveTurnId: () => string | null;
}>;

export function createConnectedServiceContinuationHandler(params: Readonly<{
  credentials: Credentials;
  interruptedOriginId?: string | null;
  resumePromptMode: SessionContinuationResumePromptModeV1;
  customResumePrompt?: string | null;
  recoveryKind?: ConnectedServiceRuntimeAuthFailureKind | null;
  runtimeAuthRecovery?: RuntimeAuthRecoveryContinuationAdmission;
  resolveInterruption: (input: Readonly<{
    sessionId: string;
    action: 'hot_applied' | 'restart_requested';
    switchReason?: ConnectedServiceSessionAuthSwitchReason;
  }>) => ConnectedServiceContinuationInterruption;
}>) {
  const dispatcher = createConnectedServiceContinuationMessageDispatcher({ credentials: params.credentials });
  return async (input: Readonly<{
    sessionId: string;
    attemptId: string;
    action: 'hot_applied' | 'restart_requested';
    switchReason?: ConnectedServiceSessionAuthSwitchReason;
  }>) => {
    const interruptedOriginId = params.interruptedOriginId?.trim() ?? '';
    if (!interruptedOriginId) return;
    await dispatcher.enqueueInterruptedOriginContinuation({
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      interruptedOriginId,
      interruption: params.resolveInterruption({
        sessionId: input.sessionId,
        action: input.action,
        switchReason: input.switchReason,
      }),
      resumePromptMode: params.resumePromptMode,
      customResumePrompt: params.customResumePrompt,
      recoveryKind: params.recoveryKind,
      runtimeAuthRecovery: params.runtimeAuthRecovery,
    });
  };
}

function createContinuationLocalId(sessionId: string, attemptId: string, interruptedOriginId: string): string {
  if (!sessionId.trim() || !attemptId.trim() || !interruptedOriginId.trim()) {
    throw new Error('connected_service_continuation_identity_invalid');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, attemptId, interruptedOriginId]))
    .digest('hex')
    .slice(0, 32);
  const localId = `connected-service-continuation:${digest}`;
  const validated = readPendingLocalId(localId);
  if (validated === null) {
    throw new Error('connected_service_continuation_local_id_invalid');
  }
  return validated;
}

export function createConnectedServiceContinuationMessageDispatcher(
  deps: ConnectedServiceContinuationMessageDispatcherDeps,
) {
  const sendMessage = deps.sendMessage ?? sendSessionMessage;

  return {
    async sendContinuationPrompt(input: Readonly<{
      sessionId: string;
      prompt: string;
      localId: string;
      isCurrent?: Parameters<typeof sendSessionMessage>[0]['canAdmit'];
    }>): Promise<Readonly<{ suppressed: boolean }>> {
      const sent = await sendMessage({
        credentials: deps.credentials,
        idOrPrefix: input.sessionId,
        message: input.prompt,
        localId: input.localId,
        requestedAction: { v: 1, kind: 'send_now' },
        pendingAdmissionMode: 'continuation_if_no_queued_user_input',
        ...(input.isCurrent ? { canAdmit: input.isCurrent } : {}),
        resumeInactiveSession: false,
        wait: false,
        timeoutMs: 1,
      });
      if (!sent.ok) {
        throw new Error(`continuation_prompt_send_failed:${sent.code}`);
      }
      return { suppressed: sent.suppressed === true };
    },

    async enqueueInterruptedOriginContinuation(input: Readonly<{
      sessionId: string;
      attemptId: string;
      interruptedOriginId: string;
      interruption: ConnectedServiceContinuationInterruption;
      resumePromptMode: SessionContinuationResumePromptModeV1;
      customResumePrompt?: string | null;
      recoveryKind?: ConnectedServiceRuntimeAuthFailureKind | null;
      afterUsageLimitReset?: boolean;
      runtimeAuthRecovery?: RuntimeAuthRecoveryContinuationAdmission;
      isCurrent?: Parameters<typeof sendSessionMessage>[0]['canAdmit'];
    }>): Promise<
      | Readonly<{ status: 'not_interrupted' | 'disabled' | 'suppressed_newer_user_input' }>
      | Readonly<{ status: 'enqueued'; localId: string }>
    > {
      if (input.interruption === 'none' || input.interruption === 'clean_boundary') {
        return { status: 'not_interrupted' };
      }
      if (input.resumePromptMode === 'off') {
        return { status: 'disabled' };
      }
      const prompt = buildContinuationResumePrompt({
        resumePromptMode: input.resumePromptMode,
        customResumePrompt: input.customResumePrompt,
        recoveryKind: input.recoveryKind,
        afterUsageLimitReset: input.afterUsageLimitReset,
      });
      const localId = createContinuationLocalId(input.sessionId, input.attemptId, input.interruptedOriginId);
      const recovery = input.runtimeAuthRecovery;
      const isCurrent: typeof input.isCurrent = recovery
        ? async (context) => {
            if (input.isCurrent && !(await input.isCurrent(context))) return false;
            if (!recovery.isCurrent()) return false;
            const session = context.rawSession;
            const activeTurnId = recovery.readActiveTurnId();
            const failedAtMs = session.lastRuntimeIssue?.occurredAt ?? session.latestTurnStatusObservedAt;
            // The latest turn projection covers consumed messages too; queued-input
            // admission alone cannot protect a newer running/completed/failed turn.
            if (session.archivedAt != null
              || (activeTurnId && session.latestTurnId && activeTurnId !== session.latestTurnId)) return false;
            if (session.latestTurnStatus === 'failed' && typeof failedAtMs === 'number'
              && Number.isFinite(recovery.armedAtMs)) return failedAtMs <= recovery.armedAtMs;
            if ((session.latestTurnStatus === 'completed' || session.latestTurnStatus === 'cancelled')
              && typeof session.latestTurnStatusObservedAt === 'number'
              && session.latestTurnStatusObservedAt > recovery.armedAtMs) return false;
            // Local failure reporting deliberately does not await the durable turn
            // projection. An unresolved original turn is neither admission nor proof
            // of newer user work. Reject retryably so correlation retains custody and
            // the existing recovery scheduler can retry after the projection arrives.
            const code = 'connected_service_continuation_turn_projection_pending';
            logger.infoFile('[ConnectedServices] Runtime-auth continuation awaiting turn projection', { sessionId: input.sessionId, code });
            throw Object.assign(new Error(code), { code, retryable: true });
          }
        : input.isCurrent;
      const sent = await this.sendContinuationPrompt({ sessionId: input.sessionId, prompt, localId, isCurrent });
      if (sent.suppressed) {
        return { status: 'suppressed_newer_user_input' };
      }
      return { status: 'enqueued', localId };
    },
  };
}
