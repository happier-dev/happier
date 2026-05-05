import { describe, expect, it } from 'vitest';

import { summarizeExpoPushTicketErrorsForLog } from './pushTicketLogSummary';

describe('summarizeExpoPushTicketErrorsForLog', () => {
  it('redacts token-like fields from details', () => {
    const res = summarizeExpoPushTicketErrorsForLog([
      {
        status: 'error',
        message: 'DeviceNotRegistered for ExpoPushToken[modern]',
        details: {
          expoPushToken: 'ExponentPushToken[abc]',
          token: 'secret',
          Authorization: 'Bearer secret',
          nested: { authToken: 'secret2', ok: true, receipt: 'ExpoPushToken[modern]' },
        },
      },
    ]);

    expect(res).toEqual([
      {
        message: 'DeviceNotRegistered for [REDACTED]',
        details: { nested: { ok: true, receipt: '[REDACTED]' } },
      },
    ]);
    expect(JSON.stringify(res)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(res)).not.toContain('ExpoPushToken');
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
