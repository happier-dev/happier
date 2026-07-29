import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerKillSessionHandler } from './killSession';

describe('registerKillSessionHandler', () => {
  it('returns requested without treating termination initiation as physical exit', async () => {
    const handlers = new Map<string, (input: unknown) => unknown>();
    const killThisHappier = vi.fn(async () => new Promise<void>(() => {}));

    registerKillSessionHandler({
      registerHandler(method, handler) {
        handlers.set(method, handler as (input: unknown) => unknown);
      },
    }, killThisHappier);

    await expect(handlers.get(RPC_METHODS.KILL_SESSION)?.({})).resolves.toEqual({ status: 'requested' });
    expect(killThisHappier).toHaveBeenCalledTimes(1);
  });

  it('keeps duplicate requests truthful while cleanup is already in progress', async () => {
    const handlers = new Map<string, (input: unknown) => unknown>();
    const killThisHappier = vi.fn(async () => new Promise<void>(() => {}));

    registerKillSessionHandler({
      registerHandler(method, handler) {
        handlers.set(method, handler as (input: unknown) => unknown);
      },
    }, killThisHappier);

    const handler = handlers.get(RPC_METHODS.KILL_SESSION);
    await expect(handler?.({})).resolves.toEqual({ status: 'requested' });
    await expect(handler?.({})).resolves.toEqual({ status: 'requested' });
  });
});
