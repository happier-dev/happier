import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { MessageQueue2 } from '../../../agent/runtime/modeMessageQueue';

import { requestSwitchToTerminal } from './requestSwitchToTerminal';

type Mode = { localId?: string | null };

describe('requestSwitchToTerminal', () => {
  it('fails closed when pending UI messages exist without a tty confirmation path', async () => {
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const requestSwitch = vi.fn(async () => undefined);

    const switched = await requestSwitchToTerminal({
      queue,
      session: {
        peekPendingMessageQueueV2Count: vi.fn().mockResolvedValue(2),
        discardPendingMessageQueueV2All: vi.fn(),
        discardCommittedMessageLocalIds: vi.fn(),
        sendSessionEvent: vi.fn(),
      },
      resolveLocalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitch,
      formatSwitchDeniedMessage: (reason) => `denied:${reason}`,
      formatError: (error) => String(error),
    });

    expect(switched).toBe(false);
    expect(requestSwitch).not.toHaveBeenCalled();
  });

  it('switches when terminal mode is available and nothing must be discarded', async () => {
    const queue = new MessageQueue2<Mode>(() => 'hash');
    const requestSwitch = vi.fn(async () => undefined);

    const switched = await requestSwitchToTerminal({
      queue,
      session: {
        peekPendingMessageQueueV2Count: vi.fn().mockResolvedValue(0),
        discardPendingMessageQueueV2All: vi.fn(),
        discardCommittedMessageLocalIds: vi.fn(),
        sendSessionEvent: vi.fn(),
      },
      resolveLocalSwitchAvailability: vi.fn(async () => ({ ok: true as const })),
      requestSwitch,
      formatSwitchDeniedMessage: (reason) => `denied:${reason}`,
      formatError: (error) => String(error),
    });

    expect(switched).toBe(true);
    expect(requestSwitch).toHaveBeenCalledTimes(1);
  });
});
