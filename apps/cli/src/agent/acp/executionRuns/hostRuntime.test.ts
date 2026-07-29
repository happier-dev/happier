import { describe, expect, it, vi } from 'vitest';

import { provisionAcpBackendExecutionRunSession } from './hostRuntime';

describe('provisionAcpBackendExecutionRunSession', () => {
  it('submits an initial prompt through the typed ACP submission boundary', async () => {
    const startSession = vi.fn(async () => ({ sessionId: 'provider-session' }));
    const sendPrompt = vi.fn(async () => ({ kind: 'accepted_by_prompt_response' as const }));

    await expect(provisionAcpBackendExecutionRunSession({
      startSession,
      sendPrompt,
    }, {
      initialPrompt: 'boot prompt',
    })).resolves.toEqual({ sessionId: 'provider-session' });

    expect(startSession).toHaveBeenCalledWith();
    expect(sendPrompt).toHaveBeenCalledWith('provider-session', 'boot prompt');
  });

  it('rejects provisioning when the initial prompt was proven rejected before effect', async () => {
    const rejection = new Error('initial prompt rejected');

    await expect(provisionAcpBackendExecutionRunSession({
      startSession: async () => ({ sessionId: 'provider-session' }),
      sendPrompt: async () => ({ kind: 'rejected_before_effect', error: rejection }),
    }, {
      initialPrompt: 'boot prompt',
    })).rejects.toBe(rejection);
  });
});
