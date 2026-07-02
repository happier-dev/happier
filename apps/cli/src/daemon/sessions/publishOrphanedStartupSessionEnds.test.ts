import { describe, expect, it, vi } from 'vitest';

import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';

describe('publishOrphanedStartupSessionEnds', () => {
  it('prefers durable session-end mutation publishing when available', () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };

    publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'sess-orphaned-6480',
          pid: 6480,
        },
      ],
      now: () => 123456789,
    });

    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalledWith({
      sid: 'sess-orphaned-6480',
      time: 123456789,
      exit: {
        observedBy: 'daemon',
        pid: 6480,
        reason: 'process-missing',
        code: null,
        signal: null,
      },
    });
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
  });
});
