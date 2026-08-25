import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';

import {
  resolvePreflightSessionControlsProbeEnvironment,
  withPreflightSessionControlsProbeEnvironment,
} from './preflightSessionControlsProbeEnvironment';

const resolveColdProbeEnvironmentFromUntrustedInput = resolvePreflightSessionControlsProbeEnvironment as unknown as (
  params: Readonly<Record<string, unknown>>,
) => ReturnType<typeof resolvePreflightSessionControlsProbeEnvironment>;

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

describe('resolvePreflightSessionControlsProbeEnvironment', () => {
  it('passes only approved platform and runtime values to cold probe callbacks', async () => {
    const processEnv = {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/alice',
      XDG_CONFIG_HOME: '/Users/alice/.config',
      CODEX_HOME: '/Users/alice/.codex',
      HAPPIER_HOME_DIR: '/Users/alice/.happier',
      HAPPIER_CODEX_PATH: '/opt/happier/codex',
      HAPPIER_JS_RUNTIME_PATH: '/opt/happier/node',
      HAPPIER_MANAGED_NODE_BIN: '/opt/happier/managed-node',
      HAPPIER_NODE_PATH: '/opt/happier/node-compat',
      OPENAI_API_KEY: 'ambient-openai-api-key',
      ANTHROPIC_API_KEY: 'ambient-anthropic-api-key',
      CODEX_API_KEY: 'ambient-codex-api-key',
      OPENAI_ACCESS_TOKEN: 'ambient-openai-access-token',
      HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH: '/private/request-auth-capability.json',
      HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH: '/private/cliproxy-capability.json',
      UNRELATED_SECRET: 'ambient-unrelated-secret',
    } satisfies NodeJS.ProcessEnv;

    const received = await withPreflightSessionControlsProbeEnvironment(
      { agentId: 'codex', processEnv },
      async ({ env }) => env,
    );

    expect(received).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/alice',
      XDG_CONFIG_HOME: '/Users/alice/.config',
      CODEX_HOME: '/Users/alice/.codex',
      HAPPIER_HOME_DIR: '/Users/alice/.happier',
      HAPPIER_CODEX_PATH: '/opt/happier/codex',
      HAPPIER_JS_RUNTIME_PATH: '/opt/happier/node',
      HAPPIER_MANAGED_NODE_BIN: '/opt/happier/managed-node',
      HAPPIER_NODE_PATH: '/opt/happier/node-compat',
    });
  });

  it('adds only an explicit materializer-produced environment after cold-probe sanitization', async () => {
    const received = await withPreflightSessionControlsProbeEnvironment(
      {
        agentId: 'opencode',
        processEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'ambient-key-must-be-removed',
        },
        materializedEnv: {
          ANTHROPIC_API_KEY: 'selected-account-key',
          OPENCODE_CONFIG: '/private/materialized/opencode.json',
        },
      },
      async ({ env }) => env,
    );

    expect(received).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'selected-account-key',
      OPENCODE_CONFIG: '/private/materialized/opencode.json',
    });
  });

  it('preserves case-insensitive Windows process prerequisites without retaining ambient credentials', async () => {
    await withPlatform('win32', async () => {
      const received = await withPreflightSessionControlsProbeEnvironment(
        {
          agentId: 'codex',
          processEnv: {
            path: 'C:\\Windows\\System32;C:\\tools',
            userprofile: 'C:\\Users\\Alice',
            systemroot: 'C:\\Windows',
            comspec: 'C:\\Windows\\System32\\cmd.exe',
            pathext: '.COM;.EXE;.BAT;.CMD',
            temp: 'C:\\Users\\Alice\\AppData\\Local\\Temp',
            happier_codex_path: 'C:\\tools\\codex.cmd',
            openai_api_key: 'ambient-openai-api-key',
            anthropic_api_key: 'ambient-anthropic-api-key',
          },
        },
        async ({ env }) => env,
      );

      expect(received).toEqual({
        path: 'C:\\Windows\\System32;C:\\tools',
        userprofile: 'C:\\Users\\Alice',
        systemroot: 'C:\\Windows',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
        pathext: '.COM;.EXE;.BAT;.CMD',
        temp: 'C:\\Users\\Alice\\AppData\\Local\\Temp',
        happier_codex_path: 'C:\\tools\\codex.cmd',
      });
    });
  });

  it('does not infer a CLI override key from unrecognized agent text', async () => {
    const resolved = await resolveColdProbeEnvironmentFromUntrustedInput({
      agentId: 'connected-account-request-auth-capability',
      processEnv: {
        PATH: '/usr/local/bin:/usr/bin',
        HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH: '/private/request-auth-capability.json',
      },
    });

    expect(resolved).toEqual({
      env: { PATH: '/usr/local/bin:/usr/bin' },
    });
  });

  it('does not materialize Connected Account credentials into cold probe environments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-env-'));
    const baseDir = join(root, 'materialized');
    const activeServerDir = join(root, 'server');
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });

    const credentials: StoredCredentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        idToken: 'id-token',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    if (credentials.encryption.type !== 'legacy') throw new Error('test expects legacy credentials');
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const getConnectedServiceCredentialSealed = vi.fn(async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex' || params.profileId !== 'work') return null;
      return {
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
      };
    });
    const getAccountEncryptionMode = vi.fn(async () => ({ mode: 'e2ee' as const }));
    const api = { getAccountEncryptionMode, getConnectedServiceCredentialSealed } as unknown as ApiClient;

    const resolved = await resolveColdProbeEnvironmentFromUntrustedInput({
      agentId: 'codex',
      probeKind: 'models',
      cwd,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      credentials,
      api,
      accountSettings: {},
      activeServerDir,
      baseDir,
      processEnv: { HOME: join(root, 'home') },
    });

    expect(resolved).toEqual({
      env: { HOME: join(root, 'home') },
    });
    expect(getAccountEncryptionMode).not.toHaveBeenCalled();
    expect(getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    await expect(readFile(join(baseDir, 'codex', 'codex-home', 'auth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not inspect or switch a selected Connected Account group for a cold probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-preflight-group-owner-'));
    const api = {} as ApiClient;

    await expect(resolveColdProbeEnvironmentFromUntrustedInput({
      agentId: 'codex',
      probeKind: 'models',
      cwd: root,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
            profileId: 'primary',
          },
        },
      },
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      api,
      activeServerDir: join(root, 'server'),
      baseDir: join(root, 'materialized'),
      processEnv: { HOME: join(root, 'home') },
    })).resolves.toEqual({
      env: { HOME: join(root, 'home') },
    });
  });
});
