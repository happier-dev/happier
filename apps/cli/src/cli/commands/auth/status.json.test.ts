import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import {
  updateSettings,
  writeCredentialsDataKey,
  writeCredentialsTokenOnly,
} from '@/persistence';
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
          envScope.patch({ HAPPIER_HOME_DIR: home });
          reloadConfiguration();

          await handleAuthCommand(['status', '--json']);

          const parsed = JSON.parse(output.text().trim()) as {
            v: number;
            ok: boolean;
            kind: string;
            error?: { code?: string };
          };
          expect(parsed.v).toBe(1);
          expect(parsed.ok).toBe(false);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.error?.code).toBe('not_authenticated');
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

  it('prints the token account ID in an auth_status JSON envelope without including the bearer token', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-ok-', async (home) => {
        const output = captureConsoleText();

        try {
          envScope.patch({ HAPPIER_HOME_DIR: home });
          reloadConfiguration();
          vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'account-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })));

          const machineKey = new Uint8Array(32).fill(8);
          const token = `header.${Buffer.from(JSON.stringify({
            sub: 'account-1',
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
          })).toString('base64url')}.signature`;
          await writeCredentialsDataKey({
            token,
            publicKey: deriveBoxPublicKeyFromSeed(machineKey),
            machineKey,
          });
          await updateSettings((settings) => ({
            ...settings,
            machineIdByServerId: { ...(settings.machineIdByServerId ?? {}), [configuration.activeServerId ?? 'cloud']: 'mid_123' },
            machineIdConfirmedByServerByServerId: {
              ...(settings.machineIdConfirmedByServerByServerId ?? {}),
              [configuration.activeServerId ?? 'cloud']: true,
            },
          }));

          await handleAuthCommand(['status', '--json']);

          const raw = output.text().trim();
          const parsed = JSON.parse(raw) as {
            ok: boolean;
            kind: string;
            data?: { authenticated?: boolean; accountId?: string | null; machineId?: string; token?: string; serverId?: string };
          };
          expect(parsed.ok).toBe(true);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.data?.authenticated).toBe(true);
          expect(parsed.data?.accountId).toBe('account-1');
          expect(parsed.data?.machineId).toBe('mid_123');
          expect(parsed.data?.serverId).toBe(configuration.activeServerId);
          expect(parsed.data?.token).toBeUndefined();
          expect(raw).not.toContain(token);
          expect(process.exitCode).toBe(0);
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

  it('reports token-only credentials as authenticated without fabricating encryption material', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-token-only-', async (home) => {
        const output = captureConsoleText();

        try {
          envScope.patch({ HAPPIER_HOME_DIR: home });
          reloadConfiguration();
          vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'plain-account' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })));

          await writeCredentialsTokenOnly({ token: 'token_plain_account' });

          await handleAuthCommand(['status', '--json']);

          const raw = output.text().trim();
          const parsed = JSON.parse(raw) as {
            ok: boolean;
            kind: string;
            data?: {
              authenticated?: boolean;
              accountId?: string | null;
              encryption?: { type?: string };
              token?: string;
            };
          };
          expect(parsed.ok).toBe(true);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.data?.authenticated).toBe(true);
          expect(parsed.data?.accountId).toBeNull();
          expect(parsed.data?.encryption).toEqual({ type: 'none' });
          expect(parsed.data?.token).toBeUndefined();
          expect(raw).not.toContain('token_plain_account');
          expect(process.exitCode).toBe(0);
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

  it('reports validation as unavailable without deleting or declaring stored credentials authenticated', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-unknown-', async (home) => {
        const output = captureConsoleText();

        try {
          envScope.patch({ HAPPIER_HOME_DIR: home });
          reloadConfiguration();
          vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('network unavailable');
          }));

          await writeCredentialsTokenOnly({ token: 'token_kept_offline' });

          await handleAuthCommand(['status', '--json']);

          const raw = output.text().trim();
          const parsed = JSON.parse(raw) as {
            ok: boolean;
            kind: string;
            error?: { code?: string };
            data?: { authenticated?: boolean; token?: string };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.error?.code).toBe('auth_status_unavailable');
          expect(parsed.data?.authenticated).not.toBe(true);
          expect(raw).not.toContain('token_kept_offline');
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
          });
          reloadConfiguration();

          const machineKey = new Uint8Array(32).fill(10);
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
            error?: { code?: string };
          };
          expect(parsed.v).toBe(1);
          expect(parsed.ok).toBe(false);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.error?.code).toBe('not_authenticated');
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

  it('honors --server-url passed after the subcommand (server selection) when resolving credentials', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const extendedEnvKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
    const extendedScope = createEnvKeyScope(extendedEnvKeys);
    try {
      await withTempDir('happier-auth-status-json-server-url-', async (home) => {
        const output = captureConsoleText();
        try {
          extendedScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_SERVER_URL: 'http://example.invalid',
            HAPPIER_ACTIVE_SERVER_ID: 'stale-host-active-server',
          });
          reloadConfiguration();
          const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
            expect(String(input)).toBe('https://api.happier.dev/v1/account/profile');
            return new Response(JSON.stringify({ id: 'acc-selected-server' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          });
          vi.stubGlobal('fetch', fetchMock);

          const machineKey = new Uint8Array(32).fill(9);

          extendedScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_SERVER_URL: 'https://api.happier.dev',
            HAPPIER_ACTIVE_SERVER_ID: undefined,
          });
          reloadConfiguration();
          await writeCredentialsDataKey({
            token: 'token_super_secret',
            publicKey: deriveBoxPublicKeyFromSeed(machineKey),
            machineKey,
          });

          extendedScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_SERVER_URL: 'http://example.invalid',
            HAPPIER_ACTIVE_SERVER_ID: 'stale-host-active-server',
          });
          reloadConfiguration();

          await handleAuthCommand(['status', '--json', '--server-url', 'https://api.happier.dev']);

          const raw = output.text().trim();
          const parsed = JSON.parse(raw) as { ok: boolean; kind: string; data?: { authenticated?: boolean; token?: string } };
          expect(parsed.ok).toBe(true);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.data?.authenticated).toBe(true);
          expect(parsed.data?.token).toBeUndefined();
          expect(raw).not.toContain('token_super_secret');
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(process.exitCode).toBe(0);
        } finally {
          output.restore();
        }
      });
    } finally {
      extendedScope.restore();
      reloadConfiguration();
      process.exitCode = prevExitCode;
    }
  });

  it('reports the saved Home refusing as another identity, without sending the stored bearer', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const homeEnvScope = createEnvKeyScope([...envKeys, 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_HOME_CARRIER_POLICY'] as const);
    const authorizationHeaders: Array<string | undefined> = [];
    // The Home behind the saved descriptor's address now reports a different identity.
    const server = createServer((req, res) => {
      authorizationHeaders.push(req.headers.authorization);
      if (req.url !== '/v1/features') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_replacement_home' } } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const serverUrl = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
    try {
      await withTempDir('happier-auth-status-json-home-refused-', async (home) => {
        const output = captureConsoleText();
        try {
          homeEnvScope.patch({
            HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
            HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined,
            HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_HOME_CARRIER_POLICY: 'automatic',
          });
          writeFileSync(join(home, 'settings.json'), JSON.stringify({
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'saved-home',
            servers: {
              'saved-home': {
                id: 'saved-home', name: 'Saved Home', serverUrl, webappUrl: serverUrl,
                homeConnectionDescriptor: {
                  v: 1, homeServerIdentityId: 'srv_saved_home', canonicalServerUrl: serverUrl, revision: 1,
                  endpoints: [{ kind: 'https', url: serverUrl }],
                },
                createdAt: 1, updatedAt: 1, lastUsedAt: 1,
              },
            },
          }), 'utf8');
          mkdirSync(join(home, 'servers', 'saved-home'), { recursive: true });
          writeFileSync(join(home, 'servers', 'saved-home', 'access.key'),
            JSON.stringify({ token: 'token_for_saved_home', encryption: null }), 'utf8');
          reloadConfiguration();

          await handleAuthCommand(['status', '--json']);

          const raw = output.text().trim();
          expect(JSON.parse(raw)).toMatchObject({
            ok: false,
            kind: 'auth_status',
            error: { code: 'auth_status_unavailable', reason: 'identity_mismatch' },
          });
          expect(raw).not.toContain('token_for_saved_home');
          expect(authorizationHeaders.length).toBeGreaterThan(0);
          expect(authorizationHeaders.every((value) => value === undefined)).toBe(true);
          expect(process.exitCode).toBe(1);
        } finally {
          output.restore();
        }
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      homeEnvScope.restore();
      envScope = createEnvKeyScope(envKeys);
      reloadConfiguration();
      process.exitCode = prevExitCode;
    }
  });
});
