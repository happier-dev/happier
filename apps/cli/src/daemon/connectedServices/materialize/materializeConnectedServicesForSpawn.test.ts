import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { resolveOpenCodeConnectedConfigHomeDir } from '@/backends/opencode/brokerPlugin';
import { buildPiBrokerMarker } from '@/backends/pi/brokerExtension';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';
import { HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { CLAUDE_SUBSCRIPTION_OAUTH_SCOPE } from '../descriptors/connectedAccountDescriptors';

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnSpy,
  };
});

describe('materializeConnectedServicesForSpawn', () => {
  beforeEach(() => {
    spawnSpy.mockImplementation((_command: string, args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      queueMicrotask(() => {
        if (args[0] === 'find-generic-password') {
          child.stderr.write('missing keychain entry');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 44);
          return;
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    });
  });

  afterEach(() => {
    spawnSpy.mockReset();
  });

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
    const sourceSqliteHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-sqlite-home-test-'));
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
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        CODEX_SQLITE_HOME: sourceSqliteHome,
        HOME: tmpdir(),
      },
    });

    expect(result).not.toBeNull();
    const expectedCodexRoot = join(baseDir, normalizeMaterializationKeyForPath('session-1'), 'codex');
    expect(result!.env.CODEX_HOME).toBe(
      join(expectedCodexRoot, 'codex-home'),
    );
    expect(result!.env.CODEX_SQLITE_HOME).toBe(sourceSqliteHome);
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      expectedCodexRoot,
    );
    expect(result!.materializationRoot).toBe(expectedCodexRoot);
    expect(result!.cleanupMaterializationRoot).toEqual(expect.any(Function));
    expect(result!.cleanupOnFailure).toBeNull();
    expect(result!.cleanupOnExit).toBeNull();

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
    // Auth secrets (accounts) are never shared, regardless of state-sharing mode.
    await expect(lstat(join(result!.env.CODEX_HOME, 'accounts'))).rejects.toThrow();
    // Session state is shared by default now (no explicit account setting required),
    // so the source rollout is reachable from the materialized Codex home.
    await expect(
      readFile(join(result!.env.CODEX_HOME, 'sessions', '2026', '05', '20', 'rollout-test.jsonl'), 'utf8'),
    ).resolves.toBe('{}\n');

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
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
    await writeFile(join(sourceCodexHome, 'history.jsonl'), '{"text":"source prompt"}\n');
    await mkdir(join(sourceCodexHome, 'memories'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'memories', 'raw_memories.md'), '# Source memory\n');
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
        scope: null,
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
    expect(result!.env.CODEX_SQLITE_HOME).toBe(sourceCodexHome);
    await expect(readFile(join(result!.env.CODEX_HOME!, 'sessions', '2026', '05', '20', 'rollout-shared.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'archived_sessions', 'rollout-archived.jsonl'), 'utf8')).resolves.toBe('{"id":"archived"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'history.jsonl'), 'utf8')).resolves.toBe('{"text":"source prompt"}\n');
    await expect(readFile(join(result!.env.CODEX_HOME!, 'memories', 'raw_memories.md'), 'utf8')).resolves.toBe('# Source memory\n');
    await expect(lstat(join(result!.env.CODEX_HOME!, 'state_5.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(result!.env.CODEX_HOME!, 'state_5.sqlite-wal'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(result!.env.CODEX_HOME!, 'goals_1.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(result!.env.CODEX_HOME!, 'logs_5.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
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
        scope: null,
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
        scope: null,
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
    const expectedCodexRoot = join(baseDir, normalizeMaterializationKeyForPath('session-1'), 'codex');
    expect(result!.env.CODEX_HOME).toBe(
      join(expectedCodexRoot, 'codex-home'),
    );
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]!)).toEqual([
      {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 7,
        credentialRevision: null,
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
    expect(resolve(codexHome).startsWith(resolve(baseDir))).toBe(true);
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
    expect(result!.env.OPENCODE_TEST_HOME).toBeUndefined();
    expect(result!.env.XDG_DATA_HOME).toBeUndefined();
    // Connected OpenCode sessions are config-isolated: XDG_CONFIG_HOME points at the Happier-owned
    // connected-config home so the user's third-party plugins never contaminate brokered auth.
    expect(result!.env.XDG_CONFIG_HOME).toBe(resolveOpenCodeConnectedConfigHomeDir());
    expect(result!.env.XDG_CACHE_HOME).toBeUndefined();
    expect(result!.env.XDG_STATE_HOME).toBeUndefined();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      join(baseDir, normalizeMaterializationKeyForPath('session-2'), 'opencode'),
    );

    const auth = JSON.parse(result!.env.OPENCODE_AUTH_CONTENT ?? '{}');
    // No-leak invariant: the brokered Codex subscription emits a non-refreshable broker marker, never
    // the OAuth refresh/access token bytes; the Anthropic Console API key is a legitimate static
    // credential and stays as a direct `{type:'api', key}` entry.
    expect(auth.openai).toEqual({
      type: 'api',
      key: expect.stringMatching(/^happier-broker:openai:/),
    });
    expect(auth.openai.refresh).toBeUndefined();
    expect(auth.openai.access).toBeUndefined();
    expect(auth.anthropic).toEqual({
      type: 'api',
      key: 'sk-ant-123',
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
    expect(result!.env.OPENCODE_TEST_HOME).toBeUndefined();
    expect(result!.env.XDG_DATA_HOME).toBeUndefined();
    // Connected OpenCode sessions are config-isolated even for direct API keys.
    expect(result!.env.XDG_CONFIG_HOME).toBe(resolveOpenCodeConnectedConfigHomeDir());
    expect(result!.env.XDG_CACHE_HOME).toBeUndefined();
    expect(result!.env.XDG_STATE_HOME).toBeUndefined();

    const auth = JSON.parse(result!.env.OPENCODE_AUTH_CONTENT ?? '{}');
    expect(auth).toEqual({
      openai: {
        type: 'api',
        key: 'sk-openai-test',
      },
    });
  });

  it('never embeds a Codex OAuth refresh token in OpenCode auth and never probes the network', async () => {
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
        refreshToken: 'super-secret-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('OAuth refresh must not be probed during materialization');
    });
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

    expect(result).not.toBeNull();
    const serializedAuth = result!.env.OPENCODE_AUTH_CONTENT ?? '{}';
    // No-leak invariant: the refresh token bytes never appear in the materialized auth payload.
    expect(serializedAuth).not.toContain('super-secret-refresh');
    const auth = JSON.parse(serializedAuth);
    expect(auth.openai).toEqual({
      type: 'api',
      key: expect.stringMatching(/^happier-broker:openai:/),
    });
    expect(auth.openai.refresh).toBeUndefined();
    expect(auth.openai.access).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects an OpenCode direct-Anthropic service that carries an oauth credential', async () => {
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

    // The direct `anthropic` Console-key service only accepts a static token credential. Claude
    // subscription OAuth is now brokered via the `claude-subscription` service; routing an OAuth
    // credential through the direct-Anthropic service is an illegal combination and must fail-closed.
    // Assert the rejection's structural shape (token-record requirement, anthropic service) rather
    // than exact wording.
    const rejection = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2b',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['anthropic', claude],
      ]),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message.toLowerCase()).toContain('anthropic');
    expect((rejection as Error).message.toLowerCase()).toContain('token credential record');
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
    expect(result!.env.PI_CODING_AGENT_DIR).toContain(baseDir);
    expect(result!.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      'openai-codex': {
        type: 'oauth',
        access: 'access',
        refresh: buildPiBrokerMarker('openai-codex', '1'),
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
    expect(result!.env.PI_CODING_AGENT_DIR).toContain(baseDir);

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

  it('materializes Claude subscription setup-token as isolated Claude Unified native auth', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"dark"}\n');
    await writeFile(
      join(sourceClaudeConfigDir, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"ambient-machine-token","scopes":[]}}\n',
    );
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-oat01-123', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6a',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['claude-subscription', setup]]),
      processEnv: {
        HOME: tmpdir(),
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    const expectedClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(expectedClaudeConfigDir);
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(expectedClaudeConfigDir);
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]!)).toEqual(
      ['CLAUDE_CONFIG_DIR'],
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'))
      .resolves.toBe('{"theme":"dark"}\n');
    expect(JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-123',
        scopes: ['user:inference'],
      },
    });
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result!.env).toBe(false);
    expect('CLAUDE_CODE_SETUP_TOKEN' in result!.env).toBe(false);
    expect('ANTHROPIC_API_KEY' in result!.env).toBe(false);
    expect(result!.diagnostics).not.toContainEqual(expect.objectContaining({ severity: 'blocking' }));
  });

  it('materializes Claude subscription oauth with an auth-isolated Claude config root', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"dark"}\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.local.json'), '{"permissions":{"allow":["Bash(echo *)"]}}\n');
    await mkdir(join(sourceClaudeConfigDir, 'agents'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'agents', 'reviewer.md'), '# Reviewer\n');
    await mkdir(join(sourceClaudeConfigDir, 'commands'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'commands', 'ship.md'), '# Ship\n');
    await mkdir(join(sourceClaudeConfigDir, 'projects'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'history.jsonl'), '{"prompt":"do not copy"}\n');
    await writeFile(join(sourceClaudeConfigDir, '.credentials.json'), '{"accessToken":"do-not-copy"}\n');
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
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6b',
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
          byAgentId: {},
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        HOME: tmpdir(),
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    const expectedClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(expectedClaudeConfigDir);
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(expectedClaudeConfigDir);
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]!)).toEqual(
      ['CLAUDE_CONFIG_DIR'],
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"dark"}\n');
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.local.json'), 'utf8')).resolves.toContain('Bash(echo *)');
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'agents', 'reviewer.md'), 'utf8')).resolves.toBe('# Reviewer\n');
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'commands', 'ship.md'), 'utf8')).resolves.toBe('# Ship\n');
    await expect(lstat(join(result!.env.CLAUDE_CONFIG_DIR!, 'projects'))).rejects.toThrow();
    await expect(lstat(join(result!.env.CLAUDE_CONFIG_DIR!, 'history.jsonl'))).rejects.toThrow();
    const credential = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'));
    expect(credential).toMatchObject({
      claudeAiOauth: {
        accessToken: 'claude-access',
        scopes: expect.arrayContaining(['user:inference', 'user:profile', 'user:sessions:claude_code']),
      },
    });
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect('CLAUDE_CODE_SETUP_TOKEN' in result!.env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result!.env).toBe(false);
    expect('ANTHROPIC_API_KEY' in result!.env).toBe(false);
  });

  it('refreshes caller-supplied Claude OAuth records before materializing a native home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    const expired = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 20,
      oauth: {
        accessToken: 'expired-access',
        refreshToken: 'expired-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const fresh = buildConnectedServiceCredentialRecord({
      now: 30,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 3_600_000,
      oauth: {
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        idToken: null,
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const refreshCredentialForMaterialization = vi.fn(async () => fresh);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-refresh-before-materialize',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['claude-subscription', expired]]),
      refreshCredentialForMaterialization,
      processEnv: {
        HOME: tmpdir(),
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    expect(refreshCredentialForMaterialization).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      record: expired,
    });
    const credential = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('fresh-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('materializes Claude Anthropic API key without inferring workspace trust from missing source state', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"dark"}\n');
    await writeFile(join(sourceClaudeConfigDir, '.claude.json'), '{"token":"do-not-copy"}\n');
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
        HOME: tmpdir(),
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'anthropic', 'work', 'claude', 'claude-config'),
    );
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(result!.env.CLAUDE_CONFIG_DIR);
    expect(JSON.parse(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]!)).toEqual(
      ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'],
    );
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"dark"}\n');
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8')).rejects.toThrow();
    expect('CLAUDE_CODE_SETUP_TOKEN' in result!.env).toBe(false);
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result!.env).toBe(false);
  });

  it('materializes only explicitly accepted Claude workspace trust without copying source secrets', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    await writeFile(join(sourceClaudeConfigDir, '.claude.json'), `${JSON.stringify({
      token: 'do-not-copy',
      projects: {
        [process.cwd()]: { hasTrustDialogAccepted: true },
      },
    })}\n`);
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-explicit-workspace-trust',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['anthropic', setup]]),
      processEnv: {
        HOME: tmpdir(),
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    const targetRootConfig = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8'));
    expect(targetRootConfig.projects?.[process.cwd()]?.hasTrustDialogAccepted).toBe(true);
    expect(JSON.stringify(targetRootConfig)).not.toContain('do-not-copy');
  });

  it('shares Claude project state only when the account setting opts in', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    await mkdir(join(sourceClaudeConfigDir, 'projects', 'repo-1'), { recursive: true });
    await writeFile(join(sourceClaudeConfigDir, 'projects', 'repo-1', 'claude-session-1.jsonl'), '{"type":"assistant"}\n');
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
        scope: CLAUDE_SUBSCRIPTION_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6c',
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
        HOME: tmpdir(),
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });

    expect(result).not.toBeNull();
    await expect(
      readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'projects', 'repo-1', 'claude-session-1.jsonl'), 'utf8'),
    ).resolves.toBe('{"type":"assistant"}\n');
  });

  it('returns a Codex state-sharing diagnostic when shared symlinks are unavailable', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-test-'));
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
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        symlink: vi.fn(async (...args: Parameters<typeof actual.symlink>) => {
          const [, destinationPath] = args;
          if (String(destinationPath).includes('sessions.happier-link')) {
            const error = new Error('symlink unavailable') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          return actual.symlink(...args);
        }),
      };
    });
    const { materializeConnectedServicesForSpawn: materializeForSpawn } = await import('./materializeConnectedServicesForSpawn');

    const result = await materializeForSpawn({
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
    expect(result!.diagnostics).toEqual([
      expect.objectContaining({
        code: 'state_symlink_unavailable',
        providerId: 'codex',
        requestedStateMode: 'shared',
        effectiveStateMode: 'isolated',
        entryName: 'sessions',
      }),
    ]);
    await expect(lstat(join(result!.env.CODEX_HOME!, 'sessions'))).rejects.toThrow();
    const auth = JSON.parse(await readFile(join(result!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('access');
    vi.doUnmock('node:fs/promises');
    vi.restoreAllMocks();
  });
});
