import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn,
} from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
  resolveFirstPartyLegacyAgentConnectedAccountServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import {
  materializeConnectedServicesForSpawn as materializeConnectedServicesForSpawnProduction,
} from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import {
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '../connectedServiceChildEnvironment';

type MaterializeParams = Parameters<typeof materializeConnectedServicesForSpawnProduction>[0];

let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

beforeAll(async () => {
  runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
    resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
      contributes: getResolvedContributionRegistry(),
      pluginIds: [
        'happier.agent.claude',
        'happier.agent.codex',
        'happier.agent.gemini',
        'happier.agent.opencode',
        'happier.agent.pi',
      ],
    }),
  });
});

afterAll(async () => {
  await runtimeRegistryLease?.release();
  runtimeRegistryLease = null;
  await pluginReloadController.shutdown({ timeoutMs: 5_000 });
});

async function materializeConnectedServicesForSpawn(
  params: MaterializeParams,
): ReturnType<typeof materializeConnectedServicesForSpawnProduction> {
  const declarationSnapshot =
    resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: params.agentId,
      contributions: runtimeRegistryLease!.registry.contributes,
    });
  if (!declarationSnapshot) {
    throw new Error(`Missing Connected Account declaration snapshot for ${params.agentId}`);
  }
  const bindings = declarationSnapshot.authorizedPurposes.flatMap((scope) => {
    const service = scope.serviceRefs[0];
    if (!service) return [];
    const serviceId =
      resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
    if (!serviceId) return [];
    const record = params.recordsByServiceId.get(serviceId);
    if (!record) return [];
    const selection = params.selectionsByServiceId?.get(serviceId);
    return [{
      purpose: scope.purpose,
      target: selection?.kind === 'group'
        ? {
            kind: 'group' as const,
            service,
            groupId: selection.groupId,
          }
        : {
            kind: 'account' as const,
            account: { service, accountId: record.profileId },
          },
    }];
  });
  return await materializeConnectedServicesForSpawnProduction({
    ...params,
    connectedAccountMaterializationAuthority:
      LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    qualifiedPurposeBindingSnapshot: {
      ...declarationSnapshot,
      bindings,
    },
  });
}

const LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY = {
  kind: 'legacy_unfenced_one_shot',
} as const satisfies MaterializeParams['connectedAccountMaterializationAuthority'];

describe('materializeConnectedServicesForSpawn', () => {

  it('persists the shared target materialized root for OpenCode continuity recovery', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'opencode',
      materializationKey: 'session-opencode',
    });
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      materializedRoot,
    );
    expect(result!.requestAuthMaterializedRoot).toBeNull();
    expect(result!.env).not.toHaveProperty(
      'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
    );
    if (process.platform !== 'win32') {
      expect((await lstat(materializedRoot)).mode & 0o777).toBe(0o700);
    }
  });

  it('awaits promoted-root absence before the promoted spawn cleanup resolves', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'opencode',
      materializationKey: 'session-cleanup-receipt',
    });
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
      materializationKey: 'session-cleanup-receipt',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.cleanupOnExit).not.toBeNull();
    expect(existsSync(materializedRoot)).toBe(true);

    await result!.cleanupOnExit!();
    expect(existsSync(materializedRoot)).toBe(false);
    await expect(result!.cleanupOnExit!()).resolves.toBeUndefined();
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
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

  it('materializes the exact-v0.2.1 OpenCode XDG auth file without probing the refresh token', async () => {
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeTruthy();
    expect(result!.env.XDG_DATA_HOME).toBeTruthy();
    expect(result!.env.OPENCODE_TEST_HOME).toBe(result!.env.HOME);
    const auth = JSON.parse(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    ));
    expect(auth).toEqual({
      openai: {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
      anthropic: { type: 'api', key: 'sk-ant-123' },
    });
    expect(result!.env).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');
    expect(fetchMock).not.toHaveBeenCalled();

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
    vi.unstubAllGlobals();
  });

  it('materializes the exact-v0.2.1 OpenCode XDG auth file with OpenAI API key credentials', async () => {
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeTruthy();
    expect(result!.env.XDG_DATA_HOME).toBeTruthy();
    const auth = JSON.parse(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    ));
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    )).toContain('stale-refresh');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('materializes exact-v0.2.1 Pi raw auth and Anthropic environment', async () => {
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3',
      }), 'pi-agent-dir'),
    );
    if (process.platform !== 'win32') {
      expect((await lstat(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3',
      }))).mode & 0o777).toBe(0o700);
    }
    expect(result!.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      'openai-codex': {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
    });
    expect(result!.env).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');

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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3-openai',
      }), 'pi-agent-dir'),
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
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
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

  it('materializes Claude subscription setup tokens into the isolated native Claude home', async () => {
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

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'claude',
      materializationKey: 'session-6a',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['claude-subscription', setup]]),
      processEnv: {
        ...process.env,
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    });
    expect(result).not.toBeNull();
    expect(JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-123',
        scopes: ['user:inference'],
      },
    });
    expect(result!.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result!.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
  });
});
