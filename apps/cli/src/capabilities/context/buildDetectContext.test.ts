import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';

describe('buildDetectContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each(['tool.executionRuns', 'cli.custom-acp'] as const)('does not block %s on slow unrelated executable discovery', async id => {
    const observed = createDeferred();
    const blocked = createDeferred<void>();
    let released = false;
    // Filesystem executable access is the genuine OS boundary. Keep the real
    // snapshot resolver; no timing threshold or internal detector mock decides
    // whether a protocol-only request depends on unrelated Agent discovery.
    const access = vi.fn(async () => {
      if (!released) {
        observed.resolve();
        await blocked.promise;
      }
      throw Object.assign(new Error('No executable in this fixture'), { code: 'ENOENT' });
    });
    vi.doMock('fs/promises', async () => ({
      ...await vi.importActual<typeof import('fs/promises')>('fs/promises'), access,
    }));
    const { buildDetectContext } = await import('./buildDetectContext');
    const pending = buildDetectContext([{ id, params: { bypassCache: true } }]);
    try {
      expect(await Promise.race([
        pending.then(context => ({ kind: 'ready', hasSnapshot: context.cliSnapshot !== null })),
        observed.promise.then(() => ({ kind: 'blocked_on_executable_discovery' })),
      ])).toEqual({ kind: 'ready', hasSnapshot: id.startsWith('cli.') });
    } finally {
      released = true;
      blocked.resolve();
      await pending.catch(() => {});
      vi.doUnmock('fs/promises');
    }
  });

});
