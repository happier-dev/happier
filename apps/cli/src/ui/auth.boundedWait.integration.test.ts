import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { setStdioTtyForTest } from '@/testkit/process/stdio';

/**
 * A relay that never gets approved.
 *
 * That is not a failure — it is what every unapproved sign-in looks like from
 * here, and it is the state that used to own the terminal until the process was
 * killed. Guided setup hands `auth login` an inherited stdio terminal, so an
 * unbounded wait is a terminal nobody can get back.
 */
function pendingRelay() {
  const app = fastify({ logger: false });
  app.post('/v1/auth/request', async (_req, reply) => reply.send({ state: 'requested' }));
  app.get('/v1/auth/request/status', async (_req, reply) => reply.send({ status: 'pending', supportsV2: true }));
  return app;
}

describe('terminal auth wait bound', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_NO_BROWSER_OPEN',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_POLL_INTERVAL_MS',
    'HAPPIER_AUTH_WAIT_TIMEOUT_MS',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ] as const;

  let restoreTty: (() => void) | null = null;
  let homeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    vi.useRealTimers();
    envScope = createEnvKeyScope(envKeys);
    homeDir = await createTempDir('happier-cli-auth-bounded-wait-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_AUTH_METHOD: 'web',
      HAPPIER_AUTH_POLL_INTERVAL_MS: '1',
      HAPPIER_SERVER_URL: 'http://happier-auth-bounded.test',
      HAPPIER_WEBAPP_URL: 'http://example.test',
    });
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
  });

  afterEach(async () => {
    restoreTty?.();
    restoreTty = null;
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    await removeTempDir(homeDir);
  });

  it('stops waiting once the caller-set bound elapses and names the way back in', async () => {
    envScope.patch({ HAPPIER_AUTH_WAIT_TIMEOUT_MS: '200' });

    const app = pendingRelay();
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: process.env.HAPPIER_SERVER_URL ?? '' });
    vi.resetModules();
    const { doAuth } = await import('./auth');

    const output = captureConsoleLogAndMuteStdout();
    try {
      const startedAt = performance.now();
      const result = await doAuth();
      const elapsedMs = performance.now() - startedAt;

      expect(result).toBeNull();
      expect(elapsedMs).toBeLessThan(2_000);
      const logs = output.logs.join('\n').toLowerCase();
      expect(logs).toContain('happier auth login');
      expect(logs).toContain('create a new sign-in request');
      expect(logs).not.toContain('approve it on your phone');
    } finally {
      output.restore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 30_000);

  it('keeps waiting when no bound was asked for', async () => {
    // The default has to stay unbounded: someone watching a QR code on their
    // desk is not a hung process, and this is the same wait every existing
    // `happier auth login` performs.
    const app = pendingRelay();
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: process.env.HAPPIER_SERVER_URL ?? '' });
    vi.resetModules();
    const { doAuth } = await import('./auth');

    const output = captureConsoleLogAndMuteStdout();
    try {
      const settled = await Promise.race([
        doAuth().then(() => 'settled' as const),
        new Promise<'still-waiting'>((resolve) => setTimeout(() => resolve('still-waiting'), 750)),
      ]);

      expect(settled).toBe('still-waiting');
    } finally {
      output.restore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 30_000);
});
