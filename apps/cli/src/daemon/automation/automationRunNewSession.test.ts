import { describe, expect, it, vi } from 'vitest';

import { runAutomationAsNewSession } from './automationRunNewSession';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

describe('runAutomationAsNewSession', () => {
  it('uses the run id as a deterministic spawn nonce without handing first-input custody to the child', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: 'session-automation' }));

    await runAutomationAsNewSession({
      spawnSession,
      runId: 'run-new-prompt',
      template: {
        directory: '/tmp/happier-automation',
        pendingFirstInput: {
          text: 'Predecessor-only first input must not enter an Automation child.',
          localId: 'spawn-first-turn:predecessor-only',
        },
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/happier-automation',
      spawnNonce: 'automation:run-new-prompt',
    }));
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('pendingFirstInput');
  });

  it('fails closed before spawn when an automation run lacks a run id for nonce custody', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: 'session-automation' }));

    await expect(runAutomationAsNewSession({
      spawnSession,
      runId: '   ',
      template: {
        directory: '/tmp/happier-automation',
      },
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: 'INVALID_REQUEST',
    });

    expect(spawnSession).not.toHaveBeenCalled();
  });
});
