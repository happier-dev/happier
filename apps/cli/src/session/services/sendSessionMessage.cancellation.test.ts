import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSessionTransportContext: vi.fn(),
  enqueuePendingQueueV2MessageViaHttp: vi.fn(),
}));

vi.mock('./resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  enqueuePendingQueueV2MessageViaHttp: mocks.enqueuePendingQueueV2MessageViaHttp,
  readBlockedPendingQueueV2DeliveryByLocalIdFromServer: vi.fn(),
}));

import { sendSessionMessage } from './sendSessionMessage';

const credentials = {
  token: 'token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
};

describe('sendSessionMessage pending admission cancellation', () => {
  beforeEach(() => {
    mocks.resolveSessionTransportContext.mockReset();
    mocks.enqueuePendingQueueV2MessageViaHttp.mockReset();
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: null,
      accountEncryptionCurrentness: { mode: 'plain' },
      rawSession: {
        id: 'sess-1',
        active: true,
        metadata: '{}',
        ownerMetadata: null,
      },
    });
  });

  it('fences cancellation and distinguishes HTTP rejection from acknowledgement loss', async () => {
    const abortDuring = new AbortController();
    mocks.enqueuePendingQueueV2MessageViaHttp
      .mockResolvedValueOnce({ didWrite: true, terminal: false, suppressed: false })
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockImplementationOnce(async () => {
        abortDuring.abort();
        throw new Error('request cancelled before acknowledgement');
      });
    const abortBefore = new AbortController();
    abortBefore.abort();

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'sess-1',
      message: 'cancel before',
      wait: false,
      timeoutMs: 30_000,
      signal: abortBefore.signal,
    })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    expect(mocks.resolveSessionTransportContext).not.toHaveBeenCalled();

    const acceptedSignal = new AbortController().signal;
    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'sess-1',
      message: 'accepted',
      wait: false,
      timeoutMs: 30_000,
      signal: acceptedSignal,
    })).resolves.toMatchObject({ ok: true, waited: false });
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).toHaveBeenLastCalledWith(
      expect.objectContaining({ signal: acceptedSignal }),
    );

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'sess-1',
      message: 'known rejection',
      wait: false,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({ ok: false, code: 'admission_rejected' });

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'sess-1',
      message: 'ack lost',
      wait: false,
      timeoutMs: 30_000,
      signal: abortDuring.signal,
    })).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });
});
