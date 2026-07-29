import { describe, expect, it, vi } from 'vitest';

import type { CodexRuntimeFetch as FetchRuntimeServiceV1 } from '../runtimeFetch.js';

import { consumeCodexRateLimitResetCredit } from './rateLimitResetCreditsClient.js';

function providerResponse(code: string, windowsReset = 0): Awaited<ReturnType<FetchRuntimeServiceV1>> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    json: async () => ({ code, windows_reset: windowsReset }),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe('consumeCodexRateLimitResetCredit', () => {
  it('posts the official aggregate wire body without invented idempotency fields or headers', async () => {
    const runtimeFetch = vi.fn(async () => providerResponse('reset', 2));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      idempotencyKey: 'redeem-123',
      providerCreditId: '   ',
      runtimeFetch,
    })).resolves.toEqual({ code: 'reset', windowsReset: 2 });

    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      headers: expect.not.objectContaining({ 'Idempotency-Key': expect.anything() }),
      body: { redeem_request_id: 'redeem-123' },
    }));
  });

  it('posts the official explicit-id wire body', async () => {
    const runtimeFetch = vi.fn(async () => providerResponse('reset', 1));

    await consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      accountId: 'acct-1',
      idempotencyKey: 'redeem-456',
      providerCreditId: 'credit-123',
      runtimeFetch,
    });

    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        redeem_request_id: 'redeem-456',
        credit_id: 'credit-123',
      },
    }));
  });

  it('rejects a blank redeem request id before provider I/O', async () => {
    const runtimeFetch = vi.fn();

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      idempotencyKey: '   ',
      runtimeFetch,
    })).rejects.toThrow('missing redeem request id');
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['reset', 2, { code: 'reset', windowsReset: 2 }],
    ['nothing_to_reset', 0, { code: 'nothing_to_reset', windowsReset: 0 }],
    ['no_credit', 0, { code: 'no_credit', windowsReset: 0 }],
    ['already_redeemed', 0, { code: 'already_redeemed', windowsReset: 0 }],
  ] as const)('parses the provider %s outcome', async (code, windowsReset, expected) => {
    const runtimeFetch = vi.fn(async () => providerResponse(code, windowsReset));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      idempotencyKey: 'redeem-123',
      runtimeFetch,
    })).resolves.toEqual(expected);
  });

  it('rejects an unknown successful provider outcome', async () => {
    const runtimeFetch = vi.fn(async () => providerResponse('future_code'));

    await expect(consumeCodexRateLimitResetCredit({
      accessToken: 'access-token',
      idempotencyKey: 'redeem-123',
      runtimeFetch,
    })).rejects.toThrow('invalid consume response');
  });
});
