import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../runtime/server/managedServerState.js';
import {
  buildOpenCodeRequestAuthMarker,
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  resolveOpenCodeConnectedConfigHomeDir,
  resolveOpenCodeRequestAuthPluginPath,
} from './requestAuth/index.js';
import {
  buildOpenCodeAuthContent,
  materializeOpenCodeAuthEnvironment,
} from './materialize.js';

const ACCESS_TOKEN_SENTINEL = 'access-token-MUST-NOT-LEAK';
const REFRESH_TOKEN_SENTINEL = 'refresh-token-MUST-NOT-LEAK';

function buildOauth(
  serviceId: 'openai-codex' | 'claude-subscription',
  profileId: string,
  providerAccountId: string,
  now = 1_000,
) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId,
    profileId,
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: ACCESS_TOKEN_SENTINEL,
      refreshToken: REFRESH_TOKEN_SENTINEL,
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId,
      providerEmail: null,
    },
  });
}

function buildToken(
  serviceId: 'openai' | 'claude-subscription' | 'anthropic',
  profileId: string,
  token: string,
) {
  return buildConnectedServiceCredentialRecord({
    now: 1_000,
    serviceId,
    profileId,
    kind: 'token',
    token: { token, providerAccountId: null, providerEmail: null },
  });
}

function requestAuth(
  rootDir: string,
  provider: 'openai' | 'anthropic',
  target: 'account' | 'group' = 'account',
  selectionId = target === 'group' ? 'pool-a' : 'profile-a',
) {
  const codex = provider === 'openai';
  const service = codex
    ? { pluginId: 'happier.agent.codex', localId: 'openai-codex' }
    : { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  return {
    capabilityPath: join(rootDir, 'request-auth', 'capability.json'),
    purposeBindings: [{
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: codex ? 'openai-codex-model-request' : 'anthropic-model-request',
      },
      target: target === 'group'
        ? { kind: 'group', service, groupId: selectionId }
        : { kind: 'account', account: { service, accountId: selectionId } },
    }],
  } as const;
}

describe('OpenCode connected-account auth materialization', () => {
  it('materializes Codex OAuth as one qualified request-auth plugin with no legacy broker authority', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    try {
      const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
      const pluginDir = join(configHome, 'opencode', 'plugin');
      const legacyPluginPath = join(pluginDir, 'happier-broker-openai-1.js');
      const stablePredecessorPluginPath = join(pluginDir, 'happier-broker-openai.js');
      const stablePredecessorAnthropicPluginPath = join(pluginDir, 'happier-broker-anthropic.js');
      const staleRequestAuthV1Path = join(pluginDir, 'happier-request-auth-openai-1.js');
      const staleRequestAuthV2Path = join(pluginDir, 'happier-request-auth-openai-2.js');
      const staleAnthropicRequestAuthPath = join(pluginDir, 'happier-request-auth-anthropic-2.js');
      const unrelatedPluginPath = join(pluginDir, 'unrelated-plugin.js');
      const legacyCapabilityPath = join(rootDir, 'broker', 'capability.json');
      await mkdir(pluginDir, { recursive: true });
      await mkdir(join(rootDir, 'broker'), { recursive: true });
      await Promise.all([
        writeFile(legacyPluginPath, 'legacy broker', 'utf8'),
        writeFile(stablePredecessorPluginPath, 'stable predecessor broker', 'utf8'),
        writeFile(stablePredecessorAnthropicPluginPath, 'stable predecessor Anthropic broker', 'utf8'),
        writeFile(staleRequestAuthV1Path, 'stale request auth v1', 'utf8'),
        writeFile(staleRequestAuthV2Path, 'stale request auth v2', 'utf8'),
        writeFile(staleAnthropicRequestAuthPath, 'stale Anthropic request auth', 'utf8'),
        writeFile(unrelatedPluginPath, 'unrelated', 'utf8'),
      ]);
      await writeFile(legacyCapabilityPath, '{"token":"legacy"}', 'utf8');

      const { env } = await materializeOpenCodeAuthEnvironment({
        openaiCodex: buildOauth('openai-codex', 'profile-a', 'account-a'),
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'request-auth-openai',
        rootDir,
        requestAuth: requestAuth(rootDir, 'openai'),
      });

      expect(JSON.parse(env.OPENCODE_AUTH_CONTENT)).toEqual({
        openai: { type: 'api', key: buildOpenCodeRequestAuthMarker('openai') },
      });
      expect(env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBe(
        join(rootDir, 'request-auth', 'capability.json'),
      );
      expect(env.HAPPIER_OPENCODE_BROKER_SELECTIONS).toBeUndefined();
      expect(env.HAPPIER_OPENCODE_BROKER_REFRESH_TOKEN_PATH).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBe('');
      expect(env.XDG_CONFIG_HOME).toBe(configHome);
      const pluginSource = await readFile(resolveOpenCodeRequestAuthPluginPath(configHome, 'openai'), 'utf8');
      expect(pluginSource).toContain('"openai-codex-model-request"');
      expect(pluginSource).not.toContain(ACCESS_TOKEN_SENTINEL);
      expect(pluginSource).not.toContain(REFRESH_TOKEN_SENTINEL);
      expect((await readdir(pluginDir)).sort()).toEqual([
        'happier-request-auth-openai.js',
        'unrelated-plugin.js',
      ]);
      await expect(readFile(legacyPluginPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(stablePredecessorPluginPath, 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(stablePredecessorAnthropicPluginPath, 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(legacyCapabilityPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('materializes qualified request auth without receiving credential bytes from the host', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-qualified-request-auth-'));
    try {
      const { env } = await materializeOpenCodeAuthEnvironment({
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'qualified-request-auth-openai',
        rootDir,
        requestAuth: requestAuth(rootDir, 'openai'),
      });

      expect(JSON.parse(env.OPENCODE_AUTH_CONTENT)).toEqual({
        openai: { type: 'api', key: buildOpenCodeRequestAuthMarker('openai') },
      });
      expect(env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBe(
        join(rootDir, 'request-auth', 'capability.json'),
      );
      expect(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toBe(
        'qualified-request-auth-openai',
      );
      const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
      await expect(
        readFile(resolveOpenCodeRequestAuthPluginPath(configHome, 'openai'), 'utf8'),
      ).resolves.toContain('"openai-codex-model-request"');

      const anthropic = await materializeOpenCodeAuthEnvironment({
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'qualified-request-auth-anthropic',
        rootDir,
        requestAuth: requestAuth(rootDir, 'anthropic'),
      });
      expect(JSON.parse(anthropic.env.OPENCODE_AUTH_CONTENT)).toEqual({
        anthropic: { type: 'api', key: buildOpenCodeRequestAuthMarker('anthropic') },
      });
      await expect(
        readFile(resolveOpenCodeRequestAuthPluginPath(configHome, 'anthropic'), 'utf8'),
      ).resolves.toContain('"anthropic-model-request"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('materializes Claude OAuth through its exact Anthropic request-auth purpose', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    try {
      const { env } = await materializeOpenCodeAuthEnvironment({
        claudeSubscription: buildOauth('claude-subscription', 'profile-a', 'account-a'),
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'request-auth-anthropic',
        rootDir,
        requestAuth: requestAuth(rootDir, 'anthropic'),
      });

      expect(JSON.parse(env.OPENCODE_AUTH_CONTENT)).toEqual({
        anthropic: { type: 'api', key: buildOpenCodeRequestAuthMarker('anthropic') },
      });
      const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
      const pluginSource = await readFile(resolveOpenCodeRequestAuthPluginPath(configHome, 'anthropic'), 'utf8');
      expect(pluginSource).toContain('"anthropic-model-request"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('fails closed when OAuth lacks the exact projected purpose or capability', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    try {
      await expect(materializeOpenCodeAuthEnvironment({
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'missing-qualified-request-auth',
        rootDir,
        requestAuth: {
          capabilityPath: join(rootDir, 'request-auth', 'capability.json'),
          purposeBindings: [],
        },
      })).rejects.toThrow(/exact declared.*purpose/i);
      await expect(materializeOpenCodeAuthEnvironment({
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'mismatched-qualified-request-auth',
        rootDir,
        requestAuth: {
          capabilityPath: join(rootDir, 'request-auth', 'capability.json'),
          purposeBindings: [{
            ...requestAuth(rootDir, 'openai').purposeBindings[0],
            purpose: {
              consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
              purpose: 'wrong-purpose',
            },
          }],
        },
      })).rejects.toThrow(/exact declared.*purpose/i);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps setup tokens and direct API keys on OpenCode native auth', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-direct-'));
    try {
      const setupToken = await materializeOpenCodeAuthEnvironment({
        claudeSubscription: buildToken('claude-subscription', 'setup', 'sk-ant-oat01-setup'),
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        materializationId: 'legacy-setup-token',
        rootDir,
      });
      expect(JSON.parse(setupToken.env.OPENCODE_AUTH_CONTENT)).toEqual({
        anthropic: { type: 'api', key: 'sk-ant-oat01-setup' },
      });
      expect(setupToken.env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBeUndefined();

      const direct = await materializeOpenCodeAuthEnvironment({
        openai: buildToken('openai', 'platform', 'sk-openai'),
        anthropic: buildToken('anthropic', 'console', 'sk-anthropic'),
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        materializationId: 'legacy-direct-keys',
        rootDir,
      });
      expect(JSON.parse(direct.env.OPENCODE_AUTH_CONTENT)).toEqual({
        openai: { type: 'api', key: 'sk-openai' },
        anthropic: { type: 'api', key: 'sk-anthropic' },
      });
      expect(direct.env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps the qualified pre-materializer secret-free and uses only the host materialization identity', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-qualified-direct-'));
    try {
      const { env } = await materializeOpenCodeAuthEnvironment({
        openai: buildToken('openai', 'platform-profile-must-not-own-identity', 'sk-openai-must-not-leak'),
        anthropic: buildToken('anthropic', 'anthropic-profile-must-not-own-identity', 'sk-anthropic-must-not-leak'),
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'host-materialization-identity',
        rootDir,
      } as Parameters<typeof materializeOpenCodeAuthEnvironment>[0] & {
        connectedAccountMaterializationAuthority: 'qualified';
        materializationId: string;
      });

      expect(env).toMatchObject({
        OPENCODE_AUTH_CONTENT: '{}',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'host-materialization-identity',
      });
      expect(env.XDG_CONFIG_HOME).toBe(resolveOpenCodeConnectedConfigHomeDir(rootDir));
      const emitted = JSON.stringify(env);
      expect(emitted).not.toContain('sk-openai-must-not-leak');
      expect(emitted).not.toContain('sk-anthropic-must-not-leak');
      expect(emitted).not.toContain('platform-profile-must-not-own-identity');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps native sessions free of config isolation and connected identity', async () => {
    const { env } = await materializeOpenCodeAuthEnvironment({});

    expect(env).toEqual({ OPENCODE_AUTH_CONTENT: '{}' });
  });

  it('never places OAuth access or refresh material in content, env, identity, or assets', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-no-leak-'));
    try {
      const materialized = await materializeOpenCodeAuthEnvironment({
        openaiCodex: buildOauth('openai-codex', 'profile-a', 'account-a'),
        connectedAccountMaterializationAuthority: 'qualified',
        materializationId: 'qualified-no-leak',
        rootDir,
        requestAuth: requestAuth(rootDir, 'openai'),
      });
      const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
      const pluginSource = await readFile(resolveOpenCodeRequestAuthPluginPath(configHome, 'openai'), 'utf8');
      const emitted = JSON.stringify({ ...materialized.env, pluginSource });

      expect(emitted).not.toContain(ACCESS_TOKEN_SENTINEL);
      expect(emitted).not.toContain(REFRESH_TOKEN_SENTINEL);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('uses the host opaque identity instead of launch-time account facts', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-group-'));
    try {
      const materializeIdentity = async (profileId: string, accountId: string) => (
        await materializeOpenCodeAuthEnvironment({
          openaiCodex: buildOauth('openai-codex', profileId, accountId),
          connectedAccountMaterializationAuthority: 'qualified',
          materializationId: 'logical-pool-a',
          rootDir,
          requestAuth: requestAuth(rootDir, 'openai', 'group'),
        })
      ).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];

      expect(await materializeIdentity('member-a', 'account-a'))
        .toBe(await materializeIdentity('member-b', 'account-b'));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('uses distinct host opaque identities without hashing rotating token bytes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-account-'));
    try {
      const materializeIdentity = async (profileId: string, accountId: string, now: number) => (
        await materializeOpenCodeAuthEnvironment({
          openaiCodex: buildOauth('openai-codex', profileId, accountId, now),
          connectedAccountMaterializationAuthority: 'qualified',
          materializationId: profileId,
          rootDir,
          requestAuth: requestAuth(rootDir, 'openai', 'account', profileId),
        })
      ).env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];

      expect(await materializeIdentity('account-a', 'provider-a', 1_000))
        .toBe(await materializeIdentity('account-a', 'provider-a', 2_000));
      expect(await materializeIdentity('account-a', 'provider-a', 1_000))
        .not.toBe(await materializeIdentity('account-b', 'provider-b', 1_000));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('fails closed for unsupported credential kinds', () => {
    const invalidOpenAi = buildOauth('openai-codex', 'profile-a', 'account-a');
    expect(() => buildOpenCodeAuthContent({
      openai: { ...invalidOpenAi, serviceId: 'openai' },
      connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
    })).toThrow(/API key/i);
  });

  it('does not admit raw records without the exact legacy one-shot authority', () => {
    expect(buildOpenCodeAuthContent({
      openai: buildToken('openai', 'platform', 'sk-must-not-be-admitted'),
    })).toBe('{}');
  });

  it('does not admit request-auth authority without the qualified discriminator', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-unqualified-request-auth-'));
    try {
      await expect(materializeOpenCodeAuthEnvironment({
        materializationId: 'unqualified-request-auth',
        rootDir,
        requestAuth: requestAuth(rootDir, 'openai'),
      })).rejects.toThrow(/qualified authority/i);
      expect(() => buildOpenCodeAuthContent({
        requestAuth: requestAuth(rootDir, 'openai'),
      })).toThrow(/qualified authority/i);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
