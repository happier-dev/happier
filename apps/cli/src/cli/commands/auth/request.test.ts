import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { readFile } from 'node:fs/promises';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
const envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  vi.resetModules();
});

describe('auth request compatibility', () => {
  it('preserves relay expiry and negotiates token-only pairing through legacy-compatible JSON requests', async () => {
    await withTempDir('happier-compatible-token-only-', async (home) => {
      envScope.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const app = fastify({ logger: false });
      const expiresAt = Date.now() + 120_000;
      const requestBodies: unknown[] = [];
      app.post('/v1/auth/request', async (req, reply) => {
        requestBodies.push(req.body);
        if (requestBodies.length === 1) return reply.code(400).send({ error: 'unknown_fields' });
        return { state: 'requested', expiresAt };
      });
      await app.ready();
      const { installAxiosFastifyAdapter } = await import('@/testkit/http/axiosAdapter');
      const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
      const output = captureConsoleLogAndMuteStdout();
      try {
        const { handleAuthRequest } = await import('./request');
        try {
          await handleAuthRequest(['--json']);
        } catch (error) {
          expect(requestBodies).toEqual([
            expect.objectContaining({ supportsV2: true, supportsTokenOnly: true }),
          ]);
          expect(error).toMatchObject({ response: { data: { error: 'unknown_fields' } } });
          throw error;
        }
        const request = JSON.parse(output.logs[0] ?? '');
        expect(requestBodies).toEqual([
          expect.objectContaining({ publicKey: request.publicKey, supportsV2: true, supportsTokenOnly: true }),
          { publicKey: request.publicKey },
        ]);
        expect(request).toMatchObject({
          expiresAtMs: expiresAt,
          pairing: { expiresAtMs: expiresAt },
        });
        expect(JSON.parse(await readFile(request.stateFile, 'utf8'))).toMatchObject({ pairingExpiresAtMs: expiresAt });
      } finally {
        output.restore();
        restoreAxios();
        await app.close();
      }
    });
  });
});
