import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '../connectedServiceChildEnvironment';

describe('materializeConnectedServicesForSpawn', () => {
  it('materializes Codex auth.json and CODEX_HOME env', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-test-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
    await writeFile(join(sourceCodexHome, 'AGENTS.md'), '# User Codex instructions\n');
    await writeFile(join(sourceCodexHome, 'auth.json'), '{"access_token":"source-access"}\n');
    await mkdir(join(sourceCodexHome, 'prompts'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'prompts', 'review.md'), 'Review prompt\n');
    await mkdir(join(sourceCodexHome, 'skills', 'reviewer'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n');
    await mkdir(join(sourceCodexHome, 'accounts'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'accounts', 'personal.json'), '{"account":"personal"}\n');
    await mkdir(join(sourceCodexHome, 'sessions', '2026', '05', '20'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'sessions', '2026', '05', '20', 'rollout-test.jsonl'), '{}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env.CODEX_HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home'),
    );
    expect(typeof result!.cleanupOnFailure).toBe('function');
    expect(typeof result!.cleanupOnExit).toBe('function');

    const authPath = join(result!.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toMatchObject({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      account_id: 'acct',
    });
    expect(typeof auth.last_refresh).toBe('string');
    expect(auth.tokens).toEqual({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      account_id: 'acct',
    });
    const copiedConfig = await readFile(join(result!.env.CODEX_HOME, 'config.toml'), 'utf8');
    expect(copiedConfig).toContain('model = "gpt-5.2-codex"');
    expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
    await expect(readFile(join(result!.env.CODEX_HOME, 'AGENTS.md'), 'utf8')).resolves.toBe('# User Codex instructions\n');
    await expect(readFile(join(result!.env.CODEX_HOME, 'prompts', 'review.md'), 'utf8')).resolves.toBe('Review prompt\n');
    await expect(readFile(join(result!.env.CODEX_HOME, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).resolves.toBe('# Reviewer\n');
    await expect(lstat(join(result!.env.CODEX_HOME, 'accounts'))).rejects.toThrow();
    await expect(lstat(join(result!.env.CODEX_HOME, 'sessions'))).rejects.toThrow();

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('persists the shared target materialized root for OpenCode continuity recovery', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'openid profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-opencode',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
    });

    expect(result).not.toBeNull();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'opencode'),
    );
  });

  it('shares Codex session state only when the account setting opts in', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-test-'));
    await mkdir(join(sourceCodexHome, 'sessions', '2026', '05', '20'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'sessions', '2026', '05', '20', 'rollout-shared.jsonl'), '{"id":"shared"}\n');
    await mkdir(join(sourceCodexHome, 'archived_sessions'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'archived_sessions', 'rollout-archived.jsonl'), '{"id":"archived"}\n');
    await writeFile(join(sourceCodexHome, 'session_index.jsonl'), '{"id":"shared"}\n');
    await writeFile(join(sourceCodexHome, 'state_5.sqlite'), 'sqlite');
    await writeFile(join(sourceCodexHome, 'state_5.sqlite-wal'), 'wal');
    await writeFile(join(sourceCodexHome, 'goals_1.sqlite'), 'goals');
    await writeFile(join(sourceCodexHome, 'logs_5.sqlite'), 'logs');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(result).not.toBeNull();
    await expect(readFile(join(result!.env.CODEX_HOME!, 'sessions', '2026', '05', '20', 'rollout-shared.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'archived_sessions', 'rollout-archived.jsonl'), 'utf8')).resolves.toBe('{"id":"archived"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'state_5.sqlite'), 'utf8')).resolves.toBe('sqlite');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'state_5.sqlite-wal'), 'utf8')).resolves.toBe('wal');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'goals_1.sqlite'), 'utf8')).resolves.toBe('goals');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'logs_5.sqlite'), 'utf8')).resolves.toBe('logs');
  });

  it('removes managed Codex home shares when settings are isolated', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-test-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
    await mkdir(join(sourceCodexHome, 'prompts'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'prompts', 'review.md'), 'Review prompt\n');
    await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'sessions', 'rollout-shared.jsonl'), '{"id":"shared"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const first = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(first).not.toBeNull();
    const copiedConfig = await readFile(join(first!.env.CODEX_HOME!, 'config.toml'), 'utf8');
    expect(copiedConfig).toContain('model = "gpt-5.2-codex"');
    expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'prompts', 'review.md'), 'utf8')).resolves.toBe('Review prompt\n');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'sessions', 'rollout-shared.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');

    const isolatedRecord = buildConnectedServiceCredentialRecord({
      now: 20,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'isolated-access',
        refreshToken: 'isolated-refresh',
        idToken: 'isolated-id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const second = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', isolatedRecord]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'isolated',
              stateMode: 'isolated',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(second).not.toBeNull();
    const auth = JSON.parse(await readFile(join(second!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('isolated-access');
    await expect(lstat(join(second!.env.CODEX_HOME!, 'config.toml'))).rejects.toThrow();
    await expect(lstat(join(second!.env.CODEX_HOME!, 'prompts'))).rejects.toThrow();
    await expect(lstat(join(second!.env.CODEX_HOME!, 'sessions'))).rejects.toThrow();
  });

  it('materializes Codex OPENAI_API_KEY when OpenAI API key connected service is selected', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-openai-token',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai', record]]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.OPENAI_API_KEY).toBe('sk-openai-test');
    expect(result!.env.CODEX_HOME).toBeUndefined();
  });

  it('materializes Codex group selections into the stable group home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      selectionsByServiceId: new Map([[
        'openai-codex',
        {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 7,
          record,
          policy: { v: 1, strategy: 'priority' },
        },
      ]]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.CODEX_HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'main', 'codex', 'codex-home'),
    );
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]!)).toEqual([
      {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 7,
        policy: { v: 1, strategy: 'priority' },
      },
    ]);
    const auth = JSON.parse(await readFile(join(result!.env.CODEX_HOME, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('backup-access');
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.OPENAI_API_KEY).toBeNull();
  });

  it('does not allow materializationKey to affect filesystem path resolution', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: '../evil/../../key',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
    });

    expect(result).not.toBeNull();
    const codexHome = result!.env.CODEX_HOME!;
    expect(resolve(codexHome).startsWith(resolve(activeServerDir))).toBe(true);
    expect(codexHome).not.toContain('evil');
  });

  it('materializes OpenCode OPENCODE_AUTH_CONTENT with openai-codex oauth without probing the refresh token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'personal',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: 'user@example.com' },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('OAuth refresh must not be probed during materialization');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claude],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.cleanupOnFailure).toEqual(expect.any(Function));
    expect(result!.cleanupOnExit).toBeNull();
    expect(result!.env.HOME).toBeUndefined();
    expect(result!.env.USERPROFILE).toBeUndefined();
    expect(result!.env.XDG_DATA_HOME).toBeUndefined();
    expect(result!.env.OPENCODE_TEST_HOME).toBeUndefined();
    expect(result!.env.HAPPIER_OPENCODE_SERVER_STATE_PATH).toContain(join('opencode', 'managed-servers'));

    const auth = JSON.parse(result!.env.OPENCODE_AUTH_CONTENT ?? '{}');
    expect(auth).toEqual({
      openai: {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
      anthropic: {
        type: 'api',
        key: 'sk-ant-123',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
    vi.unstubAllGlobals();
  });

  it('materializes OpenCode OPENCODE_AUTH_CONTENT with OpenAI API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2-openai',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeUndefined();
    expect(result!.env.USERPROFILE).toBeUndefined();
    expect(result!.env.XDG_DATA_HOME).toBeUndefined();
    expect(result!.env.OPENCODE_TEST_HOME).toBeUndefined();
    expect(result!.env.HAPPIER_OPENCODE_SERVER_STATE_PATH).toContain(join('opencode', 'managed-servers'));

    const auth = JSON.parse(result!.env.OPENCODE_AUTH_CONTENT ?? '{}');
    expect(auth).toEqual({
      openai: {
        type: 'api',
        key: 'sk-openai-test',
      },
    });
  });

  it('keeps OpenCode oauth materialization local when the network would reject the refresh token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'stale-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({
        error: {
          message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.',
          type: 'invalid_request_error',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2-stale',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
      ]),
    });

    expect(result?.env.OPENCODE_AUTH_CONTENT).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects OpenCode anthropic oauth credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'personal',
      kind: 'oauth',
      expiresAt: 456,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    await expect(materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2b',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['anthropic', claude],
      ]),
    })).rejects.toThrow(/anthropic oauth/i);
  });

  it('materializes Pi auth.json with openai-codex oauth and Anthropic API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claudeSetup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claudeSetup],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.cleanupOnFailure).toEqual(expect.any(Function));
    expect(result!.cleanupOnExit).toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'pi', 'pi-agent-dir'),
    );
    expect(result!.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      'openai-codex': {
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: 123,
        accountId: 'acct',
      },
      anthropic: {
        type: 'api_key',
        key: 'sk-ant-123',
      },
    });

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('materializes Pi auth.json with OpenAI API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3-openai',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai', 'work', 'pi', 'pi-agent-dir'),
    );

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      openai: {
        type: 'api_key',
        key: 'sk-openai-test',
      },
    });
  });

  it('does not export PI_CODING_AGENT_SESSION_DIR when Pi state sharing is enabled', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3-openai',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            pi: {
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
  });

  it('keeps Pi materialization identity stable across first spawn and session re-entry', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const firstSpawn = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'spawn-1700000000000-random',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });
    const reentry = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'sess-pi-connected',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(firstSpawn).not.toBeNull();
    expect(reentry).not.toBeNull();
    expect(firstSpawn!.env.PI_CODING_AGENT_DIR).toBe(reentry!.env.PI_CODING_AGENT_DIR);
    expect(firstSpawn!.env.PI_CODING_AGENT_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai', 'work', 'pi', 'pi-agent-dir'),
    );
  });

  it('materializes Pi group selections into the stable group home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'backup-acct',
        providerEmail: null,
      },
    });
    const selection = {
      kind: 'group' as const,
      serviceId: 'openai-codex' as const,
      groupId: 'pi-main',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      record: openaiCodex,
      policy: { v: 1, strategy: 'priority' },
    };

    const firstSpawn = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'spawn-1700000000000-random',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', openaiCodex],
      ]),
      selectionsByServiceId: new Map([['openai-codex', selection]]),
    });
    const reentry = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'sess-pi-connected',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', openaiCodex],
      ]),
      selectionsByServiceId: new Map([['openai-codex', selection]]),
    });

    expect(firstSpawn).not.toBeNull();
    expect(reentry).not.toBeNull();
    expect(firstSpawn!.env.PI_CODING_AGENT_DIR).toBe(reentry!.env.PI_CODING_AGENT_DIR);
    expect(firstSpawn!.env.PI_CODING_AGENT_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'pi-main', 'pi', 'pi-agent-dir'),
    );
    expect(JSON.parse(firstSpawn!.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]!)).toEqual([
      {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'pi-main',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 7,
        policy: { v: 1, strategy: 'priority' },
      },
    ]);
  });

  it('materializes Gemini API key env vars from a gemini oauth credential', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const gemini = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'gemini',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'scope',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'gemini',
      materializationKey: 'session-4',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
    });

    expect(result).not.toBeNull();
    expect(result!.cleanupOnFailure).toEqual(expect.any(Function));
    expect(result!.cleanupOnExit).toBeNull();
    expect(typeof result!.env.HOME).toBe('string');

    const homeDir = result!.env.HOME!;
    const credsPath = join(homeDir, '.gemini', 'oauth_creds.json');
    const creds = JSON.parse(await readFile(credsPath, 'utf8'));
    expect(creds.access_token).toBe('access');
    expect(creds.refresh_token).toBe('refresh');
    expect(creds.id_token).toBe('id');
  });

  it('keeps Gemini materialization identity stable across first spawn and session re-entry', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const gemini = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'gemini',
      profileId: 'default',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'scope',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const firstSpawn = await materializeConnectedServicesForSpawn({
      agentId: 'gemini',
      materializationKey: 'spawn-1700000000000-random',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
    });
    const reentry = await materializeConnectedServicesForSpawn({
      agentId: 'gemini',
      materializationKey: 'sess-gemini-connected',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
    });

    expect(firstSpawn).not.toBeNull();
    expect(reentry).not.toBeNull();
    expect(firstSpawn!.env.HOME).toBe(reentry!.env.HOME);
    expect(firstSpawn!.env.HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'gemini', 'default', 'gemini', 'home'),
    );
  });

  it('materializes Gemini group selections into the stable group home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const gemini = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'gemini',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'backup-access',
        refreshToken: 'backup-refresh',
        idToken: 'backup-id',
        scope: 'scope',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const selection = {
      kind: 'group' as const,
      serviceId: 'gemini' as const,
      groupId: 'gemini-main',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      record: gemini,
      policy: { v: 1, strategy: 'priority' },
    };

    const firstSpawn = await materializeConnectedServicesForSpawn({
      agentId: 'gemini',
      materializationKey: 'spawn-1700000000000-random',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
      selectionsByServiceId: new Map([['gemini', selection]]),
    });
    const reentry = await materializeConnectedServicesForSpawn({
      agentId: 'gemini',
      materializationKey: 'sess-gemini-connected',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
      selectionsByServiceId: new Map([['gemini', selection]]),
    });

    expect(firstSpawn).not.toBeNull();
    expect(reentry).not.toBeNull();
    expect(firstSpawn!.env.HOME).toBe(reentry!.env.HOME);
    expect(firstSpawn!.env.HOME).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'gemini', '__groups', 'gemini-main', 'gemini', 'home'),
    );
    expect(JSON.parse(firstSpawn!.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]!)).toEqual([
      {
        kind: 'group',
        serviceId: 'gemini',
        groupId: 'gemini-main',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 7,
        policy: { v: 1, strategy: 'priority' },
      },
    ]);
    const creds = JSON.parse(await readFile(join(firstSpawn!.env.HOME, '.gemini', 'oauth_creds.json'), 'utf8'));
    expect(creds.access_token).toBe('backup-access');
  });

  it('rejects Claude anthropic oauth credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    await expect(materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-5',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['anthropic', claude]]),
    })).rejects.toThrow(/anthropic oauth/i);
  });

  it('fails closed for Claude subscription setup-token materialization', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-oat01-123', providerAccountId: null, providerEmail: null },
    });
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');

    await expect(materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6a',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['claude-subscription', setup]]),
      processEnv: {
        ...process.env,
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    })).rejects.toMatchObject({
      code: 'connected_service_materialization_blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'claude_subscription_setup_token_not_supported_for_unified',
          severity: 'blocking',
        }),
      ]),
    });
  });

  it('materializes Claude subscription oauth as native Claude Code credentials only', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    const oauth = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    await writeFile(join(sourceClaudeConfigDir, '.claude.json'), '{"theme":"dark"}\n');
    await mkdir(join(sourceClaudeConfigDir, 'commands'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'commands', 'review.md'), 'Review this\n');
    await mkdir(join(sourceClaudeConfigDir, 'projects'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'projects', 'history.jsonl'), '{"sessionId":"local"}\n');
    await writeFile(join(sourceClaudeConfigDir, '.credentials.json'), '{"token":"local"}\n');
    const targetClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    await mkdir(targetClaudeConfigDir, { recursive: true });
    await writeFile(join(targetClaudeConfigDir, '.claude.json'), '{"accessToken":"stale"}\n');

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6b',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['claude-subscription', oauth]]),
      processEnv: {
        ...process.env,
        HAPPIER_CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(targetClaudeConfigDir);
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(result!.env.CLAUDE_CONFIG_DIR);
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]!)).toEqual([
      'CLAUDE_CONFIG_DIR',
    ]);
    await expect(lstat(join(result!.env.CLAUDE_CONFIG_DIR, '.claude.json'))).rejects.toThrow();
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'commands', 'review.md'), 'utf8')).resolves.toBe(
      'Review this\n',
    );
    await expect(lstat(join(result!.env.CLAUDE_CONFIG_DIR, 'projects'))).rejects.toThrow();
    const nativeCredentials = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'));
    expect(nativeCredentials).toEqual({
      claudeAiOauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt: 123,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
      },
    });
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result!.env).toBe(false);
    expect('CLAUDE_CODE_SETUP_TOKEN' in result!.env).toBe(false);
    expect('ANTHROPIC_API_KEY' in result!.env).toBe(false);
  });

  it('copies safe Claude config from HOME when no Claude config override is set', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-source-home-test-'));
    const defaultClaudeConfigDir = join(homeDir, '.claude');
    await mkdir(defaultClaudeConfigDir, { recursive: true });
    await writeFile(join(defaultClaudeConfigDir, 'settings.json'), '{"theme":"dark"}\n');
    await mkdir(join(defaultClaudeConfigDir, 'skills', 'reviewer'), { recursive: true });
    await writeFile(join(defaultClaudeConfigDir, 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n');
    await writeFile(join(defaultClaudeConfigDir, '.credentials.json'), '{"token":"ambient"}\n');
    const oauth = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6c',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['claude-subscription', oauth]]),
      processEnv: {
        HOME: homeDir,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', 'work', 'claude', 'claude-config'),
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"dark"}\n');
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Reviewer\n',
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'))
      .resolves.toContain('claudeAiOauth');
  });

  it('shares Claude projects only when provider state sharing opts in', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"dark"}\n');
    await writeFile(join(sourceClaudeConfigDir, '.claude.json'), '{"primaryApiKey":"ambient"}\n');
    await writeFile(join(sourceClaudeConfigDir, '.credentials.json'), '{"token":"ambient"}\n');
    await mkdir(join(sourceClaudeConfigDir, 'commands'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'commands', 'review.md'), 'Review this\n');
    await mkdir(join(sourceClaudeConfigDir, 'projects', 'project-1'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'projects', 'project-1', 'vendor-session-1.jsonl'), '{"session":"native"}\n');
    const oauth = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6d',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['claude-subscription', oauth]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            claude: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
    });

    expect(result).not.toBeNull();
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).resolves.toBe(
      '{"theme":"dark"}\n',
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'commands', 'review.md'), 'utf8')).resolves.toBe(
      'Review this\n',
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'projects', 'project-1', 'vendor-session-1.jsonl'), 'utf8'))
      .resolves.toBe('{"session":"native"}\n');
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'))
      .resolves.toContain('claudeAiOauth');
    await expect(lstat(join(result!.env.CLAUDE_CONFIG_DIR, '.claude.json'))).rejects.toThrow();
  });

  it('materializes Claude Anthropic API key via ANTHROPIC_API_KEY only', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-source-home-test-'));
    const defaultClaudeConfigDir = join(homeDir, '.claude');
    await mkdir(defaultClaudeConfigDir, { recursive: true });
    await writeFile(join(defaultClaudeConfigDir, 'settings.json'), '{"theme":"anthropic"}\n');
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['anthropic', setup]]),
      processEnv: {
        HOME: homeDir,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'anthropic', 'work', 'claude', 'claude-config'),
    );
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]!)).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
    ]);
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).resolves.toBe(
      '{"theme":"anthropic"}\n',
    );
    expect('CLAUDE_CODE_SETUP_TOKEN' in result!.env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result!.env).toBe(false);
  });
});
