import { afterEach, describe, expect, it, vi } from 'vitest';

import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('daemonControlPostJson diagnostics', () => {
  it('wraps network errors with endpoint context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );

    await expect(
      daemonControlPostJson({
        port: 47001,
        path: '/stop',
        body: {},
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/port=47001.*path=\/stop/i);
  });
});
