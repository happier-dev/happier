import { describe, expect, it, vi } from 'vitest';

import { commitConnectedServiceQuotaLifecycleSessionEvents } from './commitConnectedServiceQuotaLifecycleSessionEvents';

const blockedTransition = {
  phase: 'blocked' as const,
  serviceId: 'openai-codex' as const,
  groupId: 'main',
  activeProfileId: 'primary',
  sessionIds: ['sess-1', 'sess-2'],
  cycleId: 'cycle-1900000',
  issueFingerprint: 'quota-blocked:openai-codex:main',
  resetAtMs: 1_900_000,
  reason: 'connected_service_group_quota_exhausted',
};

describe('commitConnectedServiceQuotaLifecycleSessionEvents', () => {
  it('awaits durable transcript admission for every affected session', async () => {
    const stageTranscriptEvent = vi.fn(async () => ({ persisted: true as const, delivered: false }));

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      mutationCustody: { stageTranscriptEvent },
      transition: blockedTransition,
    });

    expect(stageTranscriptEvent).toHaveBeenCalledTimes(2);
    expect(stageTranscriptEvent).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      eventId: expect.stringContaining('agent-quota-wait'),
      data: {
        type: 'agent-quota-wait',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        resetAtMs: 1_900_000,
        reason: 'connected_service_group_quota_exhausted',
      },
    }));
  });

  it('preserves stable incident ids across retries and reset-window re-observation', async () => {
    const eventIds: string[] = [];
    const mutationCustody = {
      stageTranscriptEvent: vi.fn(async (input: { eventId: string }) => {
        eventIds.push(input.eventId);
        return { persisted: true as const, delivered: false };
      }),
    };

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      mutationCustody,
      transition: { ...blockedTransition, sessionIds: ['sess-1'] },
    });
    await commitConnectedServiceQuotaLifecycleSessionEvents({
      mutationCustody,
      transition: {
        ...blockedTransition,
        sessionIds: ['sess-1'],
        cycleId: 'cycle-1900999',
        resetAtMs: 1_900_999,
      },
    });

    expect(eventIds).toHaveLength(2);
    expect(eventIds[0]).toBe(eventIds[1]);
  });

  it('does not admit an invalid blocked edge without reset timing', async () => {
    const stageTranscriptEvent = vi.fn();

    await commitConnectedServiceQuotaLifecycleSessionEvents({
      mutationCustody: { stageTranscriptEvent },
      transition: { ...blockedTransition, resetAtMs: null },
    });

    expect(stageTranscriptEvent).not.toHaveBeenCalled();
  });

  it('does not report false success when one journal admission fails', async () => {
    const stageTranscriptEvent = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'sess-1') throw new Error('journal unavailable');
      return { persisted: true as const, delivered: false };
    });

    await expect(commitConnectedServiceQuotaLifecycleSessionEvents({
      mutationCustody: { stageTranscriptEvent },
      transition: blockedTransition,
    })).rejects.toThrow('journal unavailable');
    expect(stageTranscriptEvent).toHaveBeenCalledTimes(2);
  });
});
