import type { Credentials } from '@/persistence';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';

import { createConnectedServiceContinuationMessageDispatcher } from '../continuation/createConnectedServiceContinuationMessageDispatcher';
import {
  resumeTrackedTemporaryThrottleSession,
  type TemporaryThrottleSessionResumeResult,
} from './resumeTrackedTemporaryThrottleSession';
import type { TemporaryThrottleResumeSource } from './resolveInactiveTemporaryThrottleResumeSource';
import type { TemporaryThrottleContinuationIntent } from './TemporaryThrottleRecoveryScheduler';

type ResolveRespawnOptions = (input: Readonly<{
  sessionId: string;
  spawnOptions: SpawnSessionOptions;
  vendorResumeId: string;
  defaultOptions: SpawnSessionOptions;
}>) => SpawnSessionOptions | Promise<SpawnSessionOptions>;

export type TemporaryThrottleContinuationResult =
  | Readonly<{ status: 'continued' }>
  | Readonly<{ status: 'superseded'; reason: 'newer_user_input' }>
  | Readonly<{ status: 'terminal'; lastError: string }>
  | Readonly<{
      status: 'runtime_unavailable';
      runtimeResult: Exclude<TemporaryThrottleSessionResumeResult, Readonly<{ status: 'resumed' }>>;
    }>;

/**
 * Makes the existing runner available, then hands exactly one continuation to the
 * canonical Pending owner. Runtime availability alone is never recovery success.
 */
export async function continueTrackedTemporaryThrottleSession(input: Readonly<{
  tracked: TemporaryThrottleResumeSource;
  sessionId: string;
  credentials: Credentials;
  readCredentials: () => Promise<Credentials | null>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  resolveRespawnOptions?: ResolveRespawnOptions;
  sendMessage?: typeof sendSessionMessage;
  attemptId: string;
  continuation: TemporaryThrottleContinuationIntent;
}>): Promise<TemporaryThrottleContinuationResult> {
  const runtimeResult = await resumeTrackedTemporaryThrottleSession({
    tracked: input.tracked,
    sessionId: input.sessionId,
    credentials: input.credentials,
    readCredentials: input.readCredentials,
    spawnSession: input.spawnSession,
    resolveRespawnOptions: input.resolveRespawnOptions,
  });
  if (runtimeResult.status !== 'resumed') {
    return { status: 'runtime_unavailable', runtimeResult };
  }

  const dispatcher = createConnectedServiceContinuationMessageDispatcher({
    credentials: input.credentials,
    ...(input.sendMessage ? { sendMessage: input.sendMessage } : {}),
  });
  const continuationResult = await dispatcher.enqueueInterruptedOriginContinuation({
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    interruptedOriginId: input.continuation.interruptedOriginId,
    interruption: 'provider_failed_turn',
    resumePromptMode: input.continuation.resumePromptMode,
    customResumePrompt: input.continuation.customResumePrompt,
    recoveryKind: input.continuation.recoveryKind,
  });
  if (continuationResult.status === 'enqueued') return { status: 'continued' };
  if (continuationResult.status === 'suppressed_newer_user_input') {
    return { status: 'superseded', reason: 'newer_user_input' };
  }
  return {
    status: 'terminal',
    lastError: continuationResult.status === 'disabled'
      ? 'temporary_throttle_continuation_disabled'
      : 'temporary_throttle_continuation_not_interrupted',
  };
}
