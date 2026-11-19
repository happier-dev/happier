import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { writeCredentialsTokenOnly } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { handleConfiguredAcpCatalogCliCommand } from '@/agent/acp/catalog/configured/handleCatalogCliCommand';
import '@/ui/auth';

it('reaches automatic enrollment when a named foreground Agent has an obsolete stored credential', async () => {
  const requests: Array<{ path: string | undefined; authenticated: boolean }> = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authenticated: request.headers.authorization !== undefined });
    response.writeHead(403, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_TOKEN',
    'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_AUTH_METHOD',
    'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL',
  ]);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('command exited'); });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await withTempDir('happier-foreground-relogin-', async (home) => {
      env.patch({
        HAPPIER_HOME_DIR: home,
        HAPPIER_ACTIVE_SERVER_ID: 'relogin-fixture',
        HAPPIER_SERVER_URL: origin,
        HAPPIER_LOCAL_SERVER_URL: origin,
        HAPPIER_PUBLIC_SERVER_URL: origin,
        HAPPIER_TOKEN: undefined,
        HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
        HAPPIER_AUTH_METHOD: 'mobile',
        HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0',
      });
      reloadConfiguration();
      const payload = Buffer.from(JSON.stringify({ sub: 'obsolete-account', extras: {} })).toString('base64url');
      await writeCredentialsTokenOnly({ token: `hdr.${payload}.sig` });
      const bytes = await readFile(configuration.privateKeyFile, 'utf8');

      await expect(handleConfiguredAcpCatalogCliCommand({
        args: ['acp-catalog', '--backend', 'relogin-fixture'], rawArgv: [], terminalRuntime: null,
      })).rejects.toThrow('command exited');

      expect(requests).toContainEqual({ path: '/v1/features', authenticated: false });
      expect(requests.every(({ authenticated }) => !authenticated)).toBe(true);
      await expect(readFile(configuration.privateKeyFile, 'utf8')).resolves.toBe(bytes);
    });
  } finally {
    exit.mockRestore();
    log.mockRestore();
    error.mockRestore();
    env.restore();
    reloadConfiguration();
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
  }
});
