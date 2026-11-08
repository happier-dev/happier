import { afterEach, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { publishRecipientKeyEnvelopes } from './recipientKeyEnvelopePublication';

afterEach(() => vi.useRealTimers());

it.each([401, 403, 409])('returns an HTTP %s refusal without retrying publication', async status => {
    const response = Response.json({ error: 'recipient_key_unavailable' }, { status });
    const request = vi.fn(async () => response);
    expect(await publishRecipientKeyEnvelopes(request)).toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
});

it('stops publication retries when the owning operation is canceled', async () => {
    vi.useFakeTimers();
    const attempted = createDeferred<void>();
    const controller = new AbortController();
    const request = vi.fn(async () => {
        attempted.resolve();
        return Response.json({ error: 'database_transaction_timeout' }, { status: 503 });
    });
    const pending = publishRecipientKeyEnvelopes(request, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await attempted.promise;
    controller.abort();
    await cancelled;
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledTimes(1);
});

it('retains the typed server cause when the existing retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const pending = publishRecipientKeyEnvelopes(async () =>
        Response.json({ error: 'database_transaction_timeout' }, { status: 503 }));
    const failed = expect(pending).rejects.toMatchObject({ code: 'database_transaction_timeout', status: 503 });
    await vi.runAllTimersAsync();
    await failed;
});
