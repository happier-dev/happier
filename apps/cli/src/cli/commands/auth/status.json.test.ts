import { describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeCredentialsDataKey } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { handleAuthCommand } from '../auth';

const envKeys = ['HAPPIER_HOME_DIR'] as const;
let envScope = createEnvKeyScope(envKeys);

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

  it('prints an auth_status JSON envelope without including the bearer token', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await withTempDir('happier-auth-status-json-ok-', async (home) => {
        const output = captureConsoleText();

        try {
          envScope.patch({ HAPPIER_HOME_DIR: home });
          reloadConfiguration();

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
          };
          expect(parsed.ok).toBe(true);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.data?.authenticated).toBe(true);
          expect(parsed.data?.machineId).toBe('mid_123');
          expect(parsed.data?.token).toBeUndefined();
          expect(raw).not.toContain('token_super_secret');
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

  it('honors --server-url passed after the subcommand (server selection) when resolving credentials', async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    const extendedEnvKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL'] as const;
    const extendedScope = createEnvKeyScope(extendedEnvKeys);
    try {
      await withTempDir('happier-auth-status-json-server-url-', async (home) => {
        const output = captureConsoleText();
        try {
          extendedScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'http://example.invalid' });
          reloadConfiguration();

          const machineKey = new Uint8Array(32).fill(9);

          extendedScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.happier.dev' });
          reloadConfiguration();
          await writeCredentialsDataKey({
            token: 'token_super_secret',
            publicKey: deriveBoxPublicKeyFromSeed(machineKey),
            machineKey,
          });

          extendedScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'http://example.invalid' });
          reloadConfiguration();

          await handleAuthCommand(['status', '--json', '--server-url', 'https://api.happier.dev']);

          const raw = output.text().trim();
          const parsed = JSON.parse(raw) as { ok: boolean; kind: string; data?: { authenticated?: boolean; token?: string } };
          expect(parsed.ok).toBe(true);
          expect(parsed.kind).toBe('auth_status');
          expect(parsed.data?.authenticated).toBe(true);
          expect(parsed.data?.token).toBeUndefined();
          expect(raw).not.toContain('token_super_secret');
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
});
