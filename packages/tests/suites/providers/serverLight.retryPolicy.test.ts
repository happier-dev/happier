import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';

import { isPortAvailableForListen, shouldRetryServerStart, shouldSkipServerGenerateProviders } from '../../src/testkit/process/serverLight';

async function bindPort(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve server address'));
        return;
      }
      resolve(address.port);
    });
  });
}

describe('providers: server-light retry policy', () => {
  let busy: Server | null = null;

  afterEach(async () => {
    if (!busy) return;
    await new Promise<void>((resolve) => busy!.close(() => resolve()));
    busy = null;
  });

  it('detects when a port is already occupied without log parsing', async () => {
    busy = createServer();
    const port = await bindPort(busy);
    await expect(isPortAvailableForListen(port)).resolves.toBe(false);
  });

  it('retries only on known address-in-use signals', () => {
    expect(shouldRetryServerStart({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: false,
      error: new Error('anything'),
    })).toBe(true);

    expect(shouldRetryServerStart({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: { code: 'EADDRINUSE' },
    })).toBe(true);

    expect(shouldRetryServerStart({
      attempt: 5,
      maxAttempts: 5,
      preflightPortAvailable: false,
      error: { code: 'EADDRINUSE' },
    })).toBe(false);

    expect(shouldRetryServerStart({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error('other error'),
    })).toBe(false);
  });

  it('supports explicit server generate skip flags in worker env', () => {
    expect(shouldSkipServerGenerateProviders({})).toBe(false);
    expect(shouldSkipServerGenerateProviders({ HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1' })).toBe(true);
    expect(shouldSkipServerGenerateProviders({ HAPPY_E2E_PROVIDER_SKIP_SERVER_GENERATE: 'yes' })).toBe(true);
  });
});
