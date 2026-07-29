import { describe, expect, it, vi } from 'vitest';

import { runAutomationAsNewSession } from './automationRunNewSession';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

describe('runAutomationAsNewSession', () => {
  it('uses the run id as a deterministic spawn nonce and passes first-turn custody explicitly', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: 'session-automation' }));

    await runAutomationAsNewSession({
      spawnSession,
      runId: 'run-new-prompt',
      firstInputText: 'Inspect this workspace.',
      template: {
        directory: '/tmp/happier-automation',
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/happier-automation',
      spawnNonce: 'automation:run-new-prompt',
      pendingFirstInput: {
        text: 'Inspect this workspace.',
        localId: 'spawn-first-turn:automation:run-new-prompt',
      },
    }));
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
  });

  it('does not create an empty first-input handoff', async () => {
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions) => ({ type: 'success' as const, sessionId: 'session-automation' }));

    await runAutomationAsNewSession({
      spawnSession,
      runId: 'run-without-prompt',
      firstInputText: '   ',
      template: {
        directory: '/tmp/happier-automation',
      },
    });

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
