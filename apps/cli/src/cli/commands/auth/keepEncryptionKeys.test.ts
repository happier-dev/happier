import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { readStoredCredentialsForServerId, writeCredentialsLegacy } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

// stdin is the terminal boundary; the Home is a real local HTTP server.
const answers = vi.hoisted(() => ({ next: [] as string[], asked: 0 }));
vi.mock('@/terminal/prompts/promptInput', () => ({
  promptInput: async () => { answers.asked += 1; return answers.next.shift() ?? ''; },
}));

const { handleAuthCommand } = await import('../auth');

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
const env = createEnvKeyScope(envKeys);
const bearer = `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.sig`;
const secret = new Uint8Array(32).fill(8);
afterEach(() => { env.restore(); reloadConfiguration(); answers.next = []; answers.asked = 0; });

async function withHome(mode: 'plain' | 'e2ee', run: () => Promise<void>): Promise<void> {
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') {
      response.end(JSON.stringify({ mode, version: 2, settingsVersion: 2, updatedAt: 2, signingKeyFingerprint: null,
        contentKeyFingerprint: mode === 'plain' ? null : 'content' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withTempDir('happier-keep-keys-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      reloadConfiguration();
      await writeCredentialsLegacy({ token: bearer, secret });
      const output = captureConsoleText();
      try { await run(); } finally { output.restore(); }
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
}

describe('happier auth keep-encryption-keys', () => {
  it('moves this computer\'s keys to history only after the person answers yes', async () => {
    await withHome('plain', async () => {
      answers.next = ['n'];
      await handleAuthCommand(['keep-encryption-keys']);
      expect(await readStoredCredentialsForServerId(configuration.activeServerId)).not.toHaveProperty('accountE2eeCustody');
      answers.next = ['y'];
      await handleAuthCommand(['keep-encryption-keys']);
      expect(await readStoredCredentialsForServerId(configuration.activeServerId))
        .toMatchObject({ token: bearer, encryption: { type: 'legacy', secret }, accountE2eeCustody: 'historical' });
      expect(answers.asked).toBe(2);
    });
  });

  it('asks nothing and changes nothing while the Account is end-to-end encrypted', async () => {
    await withHome('e2ee', async () => {
      await handleAuthCommand(['keep-encryption-keys']);
      expect(answers.asked).toBe(0);
      expect(await readStoredCredentialsForServerId(configuration.activeServerId)).not.toHaveProperty('accountE2eeCustody');
    });
  });
});
