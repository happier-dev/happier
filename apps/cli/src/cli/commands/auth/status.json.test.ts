import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeCredentialsDataKey, writeCredentialsTokenOnly } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { handleAuthCommand } from '../auth';

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
let envScope = createEnvKeyScope(envKeys);

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('happier auth status --json', () => {
  it('prints a not_authenticated JSON envelope when no credentials exist', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-missing-', async (home) => {
        const output = captureConsoleText();

        try {
          envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: undefined });
          reloadConfiguration();

          await handleAuthCommand(['status', '--json']);

          const parsed = JSON.parse(output.text().trim()) as {
            v: number;
            ok: boolean;
            kind: string;
            error?: { code?: string; serverId?: string };
          };
          expect(parsed.v).toBe(1);
          expect(parsed.ok).toBe(false);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.error?.code).toBe('not_authenticated');
          expect(parsed.error?.serverId).toBe(configuration.activeServerId);
          expect(process.exitCode).toBe(1);
        } finally {
          output.restore();
        }
      });
    } finally {
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      process.exitCode = prevExitCode;
    }
  });

  it('reports unavailable validation without calling stored credentials authenticated or exposing the token', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-ok-', async (home) => {
        const output = captureConsoleText();

        try {
          envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: undefined });
          reloadConfiguration();
          vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network unavailable');
          }));

          const machineKey = new Uint8Array(32).fill(8);
          await writeCredentialsDataKey({
            token: 'token_super_secret',
            publicKey: deriveBoxPublicKeyFromSeed(machineKey),
            machineKey,
          });
          await updateSettings((settings) => ({
            ...settings,
            machineIdByServerId: { ...(settings.machineIdByServerId ?? {}), [configuration.activeServerId ?? 'cloud']: 'mid_123' },
          }));

          await handleAuthCommand(['status', '--json']);

          const raw = output.text().trim();
          const parsed = JSON.parse(raw) as {
            ok: boolean;
            kind: string;
            data?: { authenticated?: boolean; machineId?: string; token?: string };
            error?: { code?: string; machineRegistered?: boolean; machineId?: string };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.error?.code).toBe('auth_unavailable');
          expect(parsed.error?.machineRegistered).toBe(true);
          expect(parsed.error?.machineId).toBe('mid_123');
          expect(parsed.data?.token).toBeUndefined();
          expect(raw).not.toContain('token_super_secret');
          expect(process.exitCode).toBe(1);
        } finally {
          output.restore();
        }
      });
    } finally {
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a not_authenticated JSON envelope when the selected server rejects the stored token', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-invalid-token-', async (home) => {
        const output = captureConsoleText();
        const server = createServer((req, res) => {
          if (req.url !== '/v1/account/profile') {
            res.statusCode = 404;
            res.end('not-found');
            return;
          }

          expect(req.headers.authorization).toBe('Bearer token_server_rejected');
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ code: 'account-not-found', error: 'Invalid token' }));
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        if (!address || typeof address === 'string') {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
          throw new Error('failed to resolve stub server address');
        }
        const serverUrl = `http://127.0.0.1:${address.port}`;

        try {
          envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_SERVER_URL: serverUrl,
            HAPPIER_WEBAPP_URL: serverUrl,
            HAPPIER_ACTIVE_SERVER_ID: undefined,
          });
          reloadConfiguration();

          const machineKey = new Uint8Array(32).fill(9);
          await writeCredentialsDataKey({
            token: 'token_server_rejected',
            publicKey: deriveBoxPublicKeyFromSeed(machineKey),
            machineKey,
          });
          await updateSettings((settings) => ({
            ...settings,
            machineIdByServerId: {
              ...(settings.machineIdByServerId ?? {}),
              [configuration.activeServerId ?? 'cloud']: 'mid_rejected',
            },
          }));

          await handleAuthCommand(['status', '--json']);

          const parsed = JSON.parse(output.text().trim()) as {
            v: number;
            ok: boolean;
            kind: string;
            error?: { code?: string; serverId?: string };
          };
          expect(parsed.v).toBe(1);
          expect(parsed.ok).toBe(false);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.error?.code).toBe('not_authenticated');
          expect(parsed.error?.serverId).toBe(configuration.activeServerId);
          expect(process.exitCode).toBe(1);
        } finally {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
          output.restore();
        }
      });
    } finally {
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      process.exitCode = prevExitCode;
    }
  });

  it.each(['dataKey', 'tokenOnly'] as const)('uses the ephemeral --server-url selection with %s credentials when resolving auth status', async (credentialType) => {
    const token = credentialType === 'tokenOnly'
      ? `header.${Buffer.from(JSON.stringify({ sub: 'acct_1' })).toString('base64url')}.sig`
      : 'token_ephemeral_server';
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-server-url-', async (home) => {
        const output = captureConsoleText();
        const server = createServer((req, res) => {
          if (req.url !== '/v1/account/profile') {
            res.statusCode = 404;
            res.end('not-found');
            return;
          }

          expect(req.headers.authorization).toBe(`Bearer ${token}`);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ id: 'acct_1', email: 'qa@example.test', username: 'qa' }));
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        if (!address || typeof address === 'string') {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
          throw new Error('failed to resolve stub server address');
        }
        const serverUrl = `http://127.0.0.1:${address.port}`;

        try {
          envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_SERVER_URL: serverUrl,
            HAPPIER_WEBAPP_URL: serverUrl,
            HAPPIER_ACTIVE_SERVER_ID: undefined,
          });
          reloadConfiguration();

          const ephemeralServerId = configuration.activeServerId;
          const machineKey = new Uint8Array(32).fill(10);
          if (credentialType === 'tokenOnly') {
            await writeCredentialsTokenOnly({ token });
          } else {
            await writeCredentialsDataKey({
              token,
              publicKey: deriveBoxPublicKeyFromSeed(machineKey),
              machineKey,
            });
          }
          await updateSettings((settings) => ({
            ...settings,
            machineIdByServerId: { ...(settings.machineIdByServerId ?? {}), [ephemeralServerId]: 'mid_ephemeral' },
          }));

          envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_SERVER_URL: undefined,
            HAPPIER_WEBAPP_URL: undefined,
            HAPPIER_ACTIVE_SERVER_ID: undefined,
          });
          reloadConfiguration();

          await handleAuthCommand(['status', '--json', '--server-url', serverUrl]);

          const parsed = JSON.parse(output.text().trim()) as {
            ok: boolean;
            kind: string;
            data?: { authenticated?: boolean; encryption?: { type: string }; machineId?: string; accountId?: string; accountLabel?: string; relayHost?: string; serverId?: string };
            error?: { code?: string; serverId?: string };
          };
          expect(parsed.ok).toBe(true);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.data?.authenticated).toBe(true);
          expect(parsed.data?.encryption).toEqual({ type: credentialType });
          expect(parsed.data?.serverId).toBe(configuration.activeServerId);
          expect(parsed.data?.machineId).toBe('mid_ephemeral');
          expect(parsed.data?.accountId).toBe('acct_1');
          // The same identity the human output prints, so a person can compare it with the app.
          expect(parsed.data?.accountLabel).toBe('qa');
          expect(parsed.data?.relayHost).toBe(`127.0.0.1:${address.port}`);
          expect(parsed.error).toBeUndefined();
          expect(process.exitCode).toBe(0);

          const human = captureConsoleText();
          try {
            await handleAuthCommand(['status', '--server-url', serverUrl]);
            expect(human.text()).toContain(`Authenticated as qa (acct_1) on 127.0.0.1:${address.port}`);
          } finally {
            human.restore();
          }
        } finally {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
          output.restore();
        }
      });
    } finally {
      envScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      process.exitCode = prevExitCode;
    }
  });
});
