import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'http://example.test' },
}));

vi.mock('../client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: (url: string) => url,
}));

import axios from 'axios';

import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';

describe('sessionMessageCatchUp (plaintext envelopes)', () => {
  it('emits new-message updates for plaintext transcript messages', async () => {
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      data: {
        messages: [
          {
            id: 'm1',
            seq: 12,
            localId: 'l1',
            createdAt: 123,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
          },
        ],
      },
    } as any);

    const updates: any[] = [];
    await catchUpSessionMessagesAfterSeq({
      token: 't',
      sessionId: 's1',
      afterSeq: 10,
      onUpdate: (u) => updates.push(u),
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body?.t).toBe('new-message');
    expect(updates[0]?.body?.message?.content?.t).toBe('plain');
  });
});

