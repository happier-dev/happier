import { describe, expect, it } from 'vitest';

import { summarizeExpoPushTicketErrorsForLog } from './pushTicketLogSummary';

describe('summarizeExpoPushTicketErrorsForLog', () => {
  it('redacts token-like fields from details', () => {
    const res = summarizeExpoPushTicketErrorsForLog([
      {
        status: 'error',
        message: 'DeviceNotRegistered',
        details: {
          expoPushToken: 'ExponentPushToken[abc]',
          token: 'secret',
          Authorization: 'Bearer secret',
          nested: { authToken: 'secret2', ok: true },
        },
      },
    ]);

    expect(res).toEqual([
      {
        message: 'DeviceNotRegistered',
        details: { nested: { ok: true } },
      },
    ]);
    expect(JSON.stringify(res)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('ignores non-error tickets', () => {
    const res = summarizeExpoPushTicketErrorsForLog([
      { status: 'ok', id: 't1' },
      { status: 'ok', id: 't2' },
    ]);
    expect(res).toEqual([]);
  });
});

