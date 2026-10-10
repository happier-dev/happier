import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGY_OAUTH_SCOPES } from '@happier-dev/agents';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const promptInputMock = vi.fn(async (_prompt: string) => 'sk-ant-test');

vi.mock('@/terminal/prompts/promptInput', () => ({
  promptInput: (prompt: string) => promptInputMock(prompt),
}));

describe('connect credential storage', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_VARIANT',
    'GEMINI_HOME',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let homeDir = '';

  beforeEach(async () => {
    envScope = createEnvKeyScope(envKeys);
    homeDir = await createTempDir('happier-cli-connect-');
    promptInputMock.mockClear();
  });

  afterEach(async () => {
    envScope.restore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    await removeTempDir(homeDir);
  });

  it('pre-reads a plain account credential and creates it with an expect-absent guard', async () => {
    const writes: unknown[] = [];
    const app = fastify({ logger: false });
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v3/connect/anthropic/profiles/default/credential', async (_request, reply) => {
      return reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v3/connect/anthropic/profiles/default/credential', async (request) => {
      writes.push(request.body);
      return {
        success: true,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      };
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-connect.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://happier-connect.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://happier-connect.test',
        HAPPIER_VARIANT: 'stable',
      });
      vi.resetModules();
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token: 'happy-token' });

      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(['claude', '--api-key'])).rejects.toThrow('process.exit:0');

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        content: {
          t: 'plain',
          v: {
            serviceId: 'anthropic',
            profileId: 'default',
            kind: 'token',
            token: { token: 'sk-ant-test' },
          },
        },
        expectedCredentialRevision: null,
      });
    } finally {
      exitSpy.mockRestore();
      restoreAxios();
      await app.close();
    }
  });

  it.each([false, true])('imports the native AGY login and explains whether browser sign-in is needed (coding permissions: %s)', async (codingPermissions) => {
    const writes: unknown[] = [];
    const app = fastify({ logger: false });
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v3/connect/antigravity/profiles/default/credential', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.post('/v3/connect/antigravity/profiles/default/credential', async (request) => {
      writes.push(request.body);
      return { success: true, credentialRevision: 'csr_abcdefghijklmnopqrstuv' };
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-connect.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code): never => { throw new Error(`process.exit:${String(code ?? '')}`); });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/token')) return Response.json({ access_token: 'test-access', scope: AGY_OAUTH_SCOPES.filter((scope) => codingPermissions || !scope.endsWith('/aicode')).join(' '), expires_in: 3600 });
      if (String(url).includes('userinfo')) return Response.json({ sub: 'test-account', email: 'a@example.test', email_verified: true });
      return Response.json({ currentTier: { id: 'tier' }, cloudaicompanionProject: 'test-project' });
    }));
    try {
      const geminiHome = join(homeDir, 'gemini');
      const login = join(geminiHome, 'antigravity-cli/antigravity-oauth-token');
      const nativeBytes = JSON.stringify({ token: { refresh_token: 'test-refresh' } });
      await mkdir(join(geminiHome, 'antigravity-cli'), { recursive: true });
      await writeFile(login, nativeBytes);
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: 'http://happier-connect.test', HAPPIER_LOCAL_SERVER_URL: 'http://happier-connect.test', HAPPIER_VARIANT: 'stable', GEMINI_HOME: geminiHome });
      vi.resetModules();
      const { writeCredentialsLegacy } = await import('@/persistence');
      await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token: 'happy-token' });
      const { handleConnectCommand } = await import('./connect');
      await expect(handleConnectCommand(['agy', '--import', '--import-source', 'cli'])).rejects.toThrow('process.exit:0');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ content: { t: 'plain', v: { serviceId: 'antigravity', kind: 'oauth', oauth: { refreshToken: 'test-refresh', providerAccountId: 'test-account' } } }, expectedCredentialRevision: null });
      const messages = output.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(messages.includes('Reconnect with browser OAuth')).toBe(!codingPermissions);
      expect(messages).not.toContain('test-refresh');
      expect(await readFile(login, 'utf8')).toBe(nativeBytes);
    } finally {
      exitSpy.mockRestore(); output.mockRestore(); restoreAxios(); await app.close();
    }
  });
});
