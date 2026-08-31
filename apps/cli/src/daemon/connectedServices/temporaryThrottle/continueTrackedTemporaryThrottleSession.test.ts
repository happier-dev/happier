import { describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '@/daemon/types';

import { continueTrackedTemporaryThrottleSession } from './continueTrackedTemporaryThrottleSession';
import { GENERIC_CONTINUATION_RESUME_PROMPT } from '../continuation/continuationResumePrompt';

function createTracked(): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess-1',
    pid: 123,
    vendorResumeId: 'vendor-resume',
    spawnOptions: {
      directory: '/tmp/project',
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    },
  };
}

describe('continueTrackedTemporaryThrottleSession', () => {
  it('settles only after the existing Pending continuation owner accepts the handoff', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess-1',
      runnerAcceptance: 'preexisting_or_adopted',
    }));
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess-1',
      localId: 'connected-service-continuation:test',
      waited: false,
    }));

    await expect(continueTrackedTemporaryThrottleSession({
      tracked: createTracked(),
      sessionId: 'sess-1',
      credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      readCredentials: async () => null,
      spawnSession,
      resolveRespawnOptions: ({ defaultOptions }) => defaultOptions,
      sendMessage,
      attemptId: 'temporary-throttle:attempt-1',
      continuation: {
        interruptedOriginId: 'turn-1',
        resumePromptMode: 'standard',
        customResumePrompt: null,
        recoveryKind: 'temporary_throttle',
      },
    })).resolves.toEqual({ status: 'continued' });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-1',
      message: GENERIC_CONTINUATION_RESUME_PROMPT,
      pendingAdmissionMode: 'continuation_if_no_queued_user_input',
      resumeInactiveSession: false,
      requestedAction: { v: 1, kind: 'send_now' },
    }));
  });

  it('treats a newer queued user input as superseding the automatic continuation', async () => {
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'sess-1',
      localId: 'connected-service-continuation:test',
      waited: false,
      suppressed: true as const,
    }));

    await expect(continueTrackedTemporaryThrottleSession({
      tracked: createTracked(),
      sessionId: 'sess-1',
      credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      readCredentials: async () => null,
      spawnSession: async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' }),
      resolveRespawnOptions: ({ defaultOptions }) => defaultOptions,
      sendMessage,
      attemptId: 'temporary-throttle:attempt-1',
      continuation: {
        interruptedOriginId: 'turn-1',
        resumePromptMode: 'standard',
        customResumePrompt: null,
        recoveryKind: 'temporary_throttle',
      },
    })).resolves.toEqual({ status: 'superseded', reason: 'newer_user_input' });
  });
});
