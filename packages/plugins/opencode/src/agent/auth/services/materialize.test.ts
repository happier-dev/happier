import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
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
      const legacyCapabilityPath = join(rootDir, 'broker', 'capability.json');
      await mkdir(pluginDir, { recursive: true });
      await mkdir(join(rootDir, 'broker'), { recursive: true });
      await writeFile(legacyPluginPath, 'legacy broker', 'utf8');
      await writeFile(legacyCapabilityPath, '{"token":"legacy"}', 'utf8');

      const { env } = await materializeOpenCodeAuthEnvironment({
        openaiCodex: buildOauth('openai-codex', 'profile-a', 'account-a'),
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
      await expect(readFile(legacyPluginPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(legacyCapabilityPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('materializes qualified request auth without receiving credential bytes from the host', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-qualified-request-auth-'));
    try {
      const { env } = await materializeOpenCodeAuthEnvironment({
        rootDir,
        requestAuth: requestAuth(rootDir, 'openai'),
      });

      expect(JSON.parse(env.OPENCODE_AUTH_CONTENT)).toEqual({
        openai: { type: 'api', key: buildOpenCodeRequestAuthMarker('openai') },
      });
      expect(env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBe(
        join(rootDir, 'request-auth', 'capability.json'),
      );
      expect(env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]).toMatch(
        /^happier-opencode-selection:v2:sha256:/,
      );
      const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
      await expect(
        readFile(resolveOpenCodeRequestAuthPluginPath(configHome, 'openai'), 'utf8'),
      ).resolves.toContain('"openai-codex-model-request"');

      const anthropic = await materializeOpenCodeAuthEnvironment({
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
        openaiCodex: buildOauth('openai-codex', 'profile-a', 'account-a'),
        rootDir,
      })).rejects.toThrow(/child capability/i);
      await expect(materializeOpenCodeAuthEnvironment({
        openaiCodex: buildOauth('openai-codex', 'profile-a', 'account-a'),
        rootDir,
        requestAuth: requestAuth(rootDir, 'anthropic'),
      })).rejects.toThrow(/exact declared openai purpose/i);
      await expect(materializeOpenCodeAuthEnvironment({
        rootDir,
        requestAuth: {
          capabilityPath: join(rootDir, 'request-auth', 'capability.json'),
          purposeBindings: [],
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
        rootDir,
      });
      expect(JSON.parse(setupToken.env.OPENCODE_AUTH_CONTENT)).toEqual({
        anthropic: { type: 'api', key: 'sk-ant-oat01-setup' },
      });
      expect(setupToken.env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBeUndefined();

      const direct = await materializeOpenCodeAuthEnvironment({
        openai: buildToken('openai', 'platform', 'sk-openai'),
        anthropic: buildToken('anthropic', 'console', 'sk-anthropic'),
        rootDir,
        managedServerStatePath: '/tmp/opencode.state.json',
      });
      expect(JSON.parse(direct.env.OPENCODE_AUTH_CONTENT)).toEqual({
        openai: { type: 'api', key: 'sk-openai' },
        anthropic: { type: 'api', key: 'sk-anthropic' },
      });
      expect(direct.env.HAPPIER_OPENCODE_SERVER_STATE_PATH).toBe('/tmp/opencode.state.json');
      expect(direct.env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBeUndefined();
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

  it('keys group sessions on logical group intent instead of the launch-time active member', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-group-'));
    try {
      const materializeIdentity = async (profileId: string, accountId: string) => (
        await materializeOpenCodeAuthEnvironment({
          openaiCodex: buildOauth('openai-codex', profileId, accountId),
          connectedServiceGroupIdsByServiceId: { 'openai-codex': 'pool-a' },
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

  it('distinguishes fixed connected accounts without hashing rotating token bytes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-opencode-account-'));
    try {
      const materializeIdentity = async (profileId: string, accountId: string, now: number) => (
        await materializeOpenCodeAuthEnvironment({
          openaiCodex: buildOauth('openai-codex', profileId, accountId, now),
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
    })).toThrow(/API key/i);
  });
});
