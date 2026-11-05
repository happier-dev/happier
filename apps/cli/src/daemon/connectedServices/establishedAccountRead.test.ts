import { describe, expect, it } from 'vitest';
import { createEstablishedAccountReadScope } from './establishedAccountRead';

describe('established Account read settlement', () => {
  it('returns admitted work after cancellation, and stops the next read', async () => {
    const scope = createEstablishedAccountReadScope({});
    const controller = new AbortController();
    const replacement = { status: 'connected', refreshToken: 'rotated-token' };
    await expect(scope.runCurrentAccountRead(async () => {
      controller.abort();
      return replacement;
    }, controller.signal)).resolves.toBe(replacement);
    let invoked = false;
    await expect(scope.runCurrentAccountRead(async () => { invoked = true; }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(invoked).toBe(false);
  });

  it('still prevents materialization disclosure after cancellation', async () => {
    const scope = createEstablishedAccountReadScope({});
    const controller = new AbortController();
    await expect(scope.runMaterialization(async () => {
      controller.abort();
      return { token: 'materialized' };
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
