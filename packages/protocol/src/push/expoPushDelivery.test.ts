import { describe, expect, it } from 'vitest';

import { collectExpoPushTokensMarkedUnregistered } from './expoPushDelivery';

describe('collectExpoPushTokensMarkedUnregistered', () => {
  it('collects tokens from immediate DeviceNotRegistered ticket errors', () => {
    const tokens = collectExpoPushTokensMarkedUnregistered({
      messages: [
        { to: 'ExponentPushToken[one]' },
        { to: 'ExponentPushToken[two]' },
      ],
      tickets: [
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok', id: 'receipt-two' },
      ],
    });

    expect(tokens).toEqual(['ExponentPushToken[one]']);
  });

  it('collects tokens from receipt-level DeviceNotRegistered errors', () => {
    const tokens = collectExpoPushTokensMarkedUnregistered({
      messages: [
        { to: 'ExponentPushToken[one]' },
        { to: ['ExponentPushToken[two]', 'ExponentPushToken[three]'] },
      ],
      tickets: [
        { status: 'ok', id: 'receipt-one' },
        { status: 'ok', id: 'receipt-two' },
      ],
      receipts: {
        'receipt-one': { status: 'ok' },
        'receipt-two': { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    });

    expect(tokens).toEqual(['ExponentPushToken[two]', 'ExponentPushToken[three]']);
  });
});
