import { describe, expect, it } from 'vitest';
import { awaitCliActionResult } from './awaitCliActionResult';

describe('CLI Action caller settlement', () => {
  it('does not issue work when the caller already cancelled', async () => {
    const caller = new AbortController();
    caller.abort();
    let issued = false;
    expect(await awaitCliActionResult(async () => {
      issued = true;
      return { ok: true, result: 'effect' };
    }, caller.signal)).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(issued).toBe(false);
  });

  it('preserves a result received before cancellation', async () => {
    const caller = new AbortController();
    const result = { ok: true, result: { nativeId: 'created' } } as const;
    const pending = awaitCliActionResult(() => Promise.resolve(result), caller.signal);
    caller.abort();
    expect(await pending).toBe(result);
  });

  it('observes late rejection without making the cancelled caller wait', async () => {
    const caller = new AbortController();
    const handler = Promise.withResolvers<never>();
    const pending = awaitCliActionResult(() => handler.promise, caller.signal);
    caller.abort();
    expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled', details: { outcome: 'unknown' } });
    handler.reject(new Error('late native failure'));
    await Promise.resolve();
  });
});
