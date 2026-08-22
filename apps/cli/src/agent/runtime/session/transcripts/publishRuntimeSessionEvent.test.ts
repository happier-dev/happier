import { describe, expect, it, vi } from 'vitest';

import { publishRuntimeSessionEvent } from './publishRuntimeSessionEvent';

describe('publishRuntimeSessionEvent', () => {
  it('returns custody only after the canonical durable transcript enqueue persists the event', async () => {
    const enqueueAgentMessageCommitted = vi
      .fn()
      .mockResolvedValueOnce({ persisted: false, delivered: false })
      .mockResolvedValueOnce({ persisted: true, delivered: false });
    const session = {
      sessionId: 'session-durable-event',
      enqueueAgentMessageCommitted,
    };
    const event = {
      type: 'terminal-composer-draft-blocked' as const,
      reason: 'idle_draft_guard' as const,
      stateAtMs: 123,
      message: 'Clear the terminal draft.',
    };

    await expect(publishRuntimeSessionEvent({
      session,
      agentId: 'claude',
      event,
    })).rejects.toMatchObject({
      code: 'runtime_transcript_required_admission_failed',
      reason: 'durable_custody_rejected',
    });
    await expect(publishRuntimeSessionEvent({
      session,
      agentId: 'claude',
      event,
    })).resolves.toEqual({ status: 'custodied' });

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(2);
    expect(enqueueAgentMessageCommitted).toHaveBeenLastCalledWith(
      'claude',
      {
        type: 'event',
        data: event,
        id: expect.any(String),
      },
      expect.objectContaining({
        localId: expect.any(String),
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
  });
});
