import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { verifyResumeReachableClaude } from '@/backends/claude/connectedServices/verifyResumeReachableClaude';
import type { TrackedSession } from '@/daemon/types';
import type { Credentials } from '@/persistence';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { materializeClaudeConnectedServiceRuntimeAuthSelection } from './materializeClaudeConnectedServiceRuntimeAuthSelection';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';

// Server HTTP boundary mock: the persisted-metadata continuity fallback fetches the session
// snapshot from the server; unit tests must never hit the network.
const mockFetchSessionByIdCompat = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mockFetchSessionByIdCompat,
}));

const CURRENT_CREDENTIAL_REVISION = 'csr_7123456789ABCDEFGHJKMNPQRS' as const;

function currentGroupApi(input: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  activeProfileId: string;
  generation: number;
}>): ApiClient {
  return {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(async () => ({
      content: { t: 'plain' as const, v: input.record },
      revisionSemantics: 'revisioned' as const,
      credentialRevision: CURRENT_CREDENTIAL_REVISION,
    })),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    getConnectedServiceAuthGroup: vi.fn(async () => ({
      serviceId: 'claude-subscription' as const,
      groupId: 'work',
      activeProfileId: input.activeProfileId,
      generation: input.generation,
    })),
  } as unknown as ApiClient;
}

describe('materializeClaudeConnectedServiceRuntimeAuthSelection', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('materializes selected group Claude subscription OAuth as native Claude Code auth', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-project-'));
    const projectDir = join(projectRoot, 'repo');
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
    const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'backup',
      selection: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'backup',
        record: buildConnectedServiceCredentialRecord({
          now: 1_000,
          serviceId: 'claude-subscription',
          profileId: 'backup',
          kind: 'oauth',
          expiresAt: 2_000,
          oauth: {
            accessToken: 'profile-access-placeholder',
            refreshToken: 'profile-refresh-placeholder',
            idToken: null,
            scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
            tokenType: 'Bearer',
            providerAccountId: 'provider-account',
            providerEmail: null,
          },
        }),
      },
    });
    if (!profileClaudeConfigDir) {
      throw new Error('expected stable profile Claude config dir');
    }
    const groupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'work',
      'claude',
      'claude-config',
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(homeDir, '.claude.json'),
      `${JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { accessToken: 'ambient-root-token-must-not-copy' },
        projects: {
          [projectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            allowedTools: ['Bash(*)'],
          },
        },
      })}\n`,
    );
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"ambient"}\n');
    await mkdir(profileClaudeConfigDir, { recursive: true });
    await writeFile(join(profileClaudeConfigDir, 'settings.json'), '{"theme":"profile"}\n');
    await writeFile(
      join(profileClaudeConfigDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: {
          emailAddress: 'profile@example.test',
          displayName: 'Profile User',
          accessToken: 'profile-root-token-must-not-copy',
        },
        projects: {
          [projectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })}\n`,
    );
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
          CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-must-not-propagate',
        },
      },
    };

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: currentGroupApi({ record, activeProfileId: 'backup', generation: 3 }),
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
        },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 3,
        credentialRevision: CURRENT_CREDENTIAL_REVISION,
        record,
      },
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
    });

    expect(result).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 3,
      targetMaterializedEnv: {
        CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
      },
      targetMaterializedRoot: groupClaudeConfigDir,
    });
    const materializedEnv = (result as { targetMaterializedEnv?: Record<string, string> }).targetMaterializedEnv;
    expect(materializedEnv?.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();

    const credential = JSON.parse(await readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(credential.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    const targetRootConfig = JSON.parse(await readFile(join(groupClaudeConfigDir, '.claude.json'), 'utf8'));
    expect(targetRootConfig.oauthAccount).toEqual({
      accountUuid: 'provider-account',
    });
    expect(targetRootConfig.hasCompletedOnboarding).toBe(true);
    expect(targetRootConfig.projects).toEqual({
      [projectDir]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    await expect(readFile(join(groupClaudeConfigDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"ambient"}\n');
  });

  it('returns shared group hot-apply metadata without rewriting the live Claude config dir first', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-project-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
    const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'backup',
      selection: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'backup',
        record: buildConnectedServiceCredentialRecord({
          now: 1_000,
          serviceId: 'claude-subscription',
          profileId: 'backup',
          kind: 'oauth',
          expiresAt: 2_000,
          oauth: {
            accessToken: 'profile-access-placeholder',
            refreshToken: 'profile-refresh-placeholder',
            idToken: null,
            scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
            tokenType: 'Bearer',
            providerAccountId: 'provider-account',
            providerEmail: null,
          },
        }),
      },
    });
    if (!profileClaudeConfigDir) throw new Error('expected stable profile Claude config dir');
    const groupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'work',
      'claude',
      'claude-config',
    );
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_hot',
      pid: 321,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: groupClaudeConfigDir,
        },
      },
    };

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: currentGroupApi({ record, activeProfileId: 'backup', generation: 4 }),
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_hot',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 4,
        },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 4,
        credentialRevision: CURRENT_CREDENTIAL_REVISION,
        record,
      },
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
    });

    expect(result).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: groupClaudeConfigDir },
      targetMaterializedRoot: groupClaudeConfigDir,
      claudeRuntimeAuthSharedGroupSurface: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir: groupClaudeConfigDir,
        runtimeMaterializedRoot: groupClaudeConfigDir,
        sourceClaudeConfigDir: profileClaudeConfigDir,
      },
    });
    await expect(readFile(join(profileClaudeConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights the deterministic shared group surface when request env predates materialization', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-project-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
    const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'backup',
      selection: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'backup',
        record: buildConnectedServiceCredentialRecord({
          now: 1_000,
          serviceId: 'claude-subscription',
          profileId: 'backup',
          kind: 'oauth',
          expiresAt: 2_000,
          oauth: {
            accessToken: 'profile-access-placeholder',
            refreshToken: 'profile-refresh-placeholder',
            idToken: null,
            scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
            tokenType: 'Bearer',
            providerAccountId: 'provider-account',
            providerEmail: null,
          },
        }),
      },
    });
    if (!profileClaudeConfigDir) throw new Error('expected stable profile Claude config dir');
    const groupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'work',
      'claude',
      'claude-config',
    );
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_hot_preflight',
      pid: 321,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {},
      },
    };
    const input = {
      tracked,
      sessionId: 'sess_hot_preflight',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      previous: {
        source: 'connected',
        selection: 'group',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: 'work',
      },
      next: {
        source: 'connected',
        selection: 'group',
        serviceId: 'claude-subscription',
        profileId: 'backup',
        groupId: 'work',
      },
      previousBindings,
      normalizedBindings,
      groupMetadata: {
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 4,
      },
      mode: 'preflight',
    } satisfies Parameters<typeof materializeClaudeConnectedServiceRuntimeAuthSelection>[0]['input']
      & Readonly<{ mode: 'preflight' }>;

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: currentGroupApi({ record, activeProfileId: 'backup', generation: 4 }),
      activeServerDir,
      input,
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 4,
        credentialRevision: CURRENT_CREDENTIAL_REVISION,
        record,
      },
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
    });

    expect(result).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: groupClaudeConfigDir },
      targetMaterializedRoot: groupClaudeConfigDir,
      claudeRuntimeAuthSharedGroupSurface: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir: groupClaudeConfigDir,
        runtimeMaterializedRoot: groupClaudeConfigDir,
        sourceClaudeConfigDir: profileClaudeConfigDir,
      },
    });
    await expect(readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(profileClaudeConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes shared group hot-apply metadata for token-backed Claude subscription groups', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-project-'));
    const groupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'work',
      'claude',
      'claude-config',
    );
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: {
        token: 'setup-token',
        providerAccountId: 'setup-account',
        providerEmail: 'setup@example.test',
      },
    });
    const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'setup',
      selection: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'setup',
        record,
      },
    });
    if (!profileClaudeConfigDir) throw new Error('expected stable profile Claude config dir');
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'group', groupId: 'work', profileId: 'setup' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_setup_token',
      pid: 321,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CONFIG_DIR: groupClaudeConfigDir,
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: groupClaudeConfigDir,
        },
      },
    };

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: currentGroupApi({ record, activeProfileId: 'setup', generation: 5 }),
      activeServerDir,
      input: {
        mode: 'preflight',
        tracked,
        sessionId: 'sess_setup_token',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'setup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'setup',
          fallbackProfileId: 'fallback',
          generation: 5,
        },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'setup',
        groupId: 'work',
        activeProfileId: 'setup',
        fallbackProfileId: 'fallback',
        generation: 5,
        credentialRevision: CURRENT_CREDENTIAL_REVISION,
        record,
      },
      processEnv: { HOME: homeDir },
    });

    expect(result).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'setup',
      groupId: 'work',
      activeProfileId: 'setup',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: groupClaudeConfigDir },
      targetMaterializedRoot: groupClaudeConfigDir,
      claudeRuntimeAuthSharedGroupSurface: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir: groupClaudeConfigDir,
        runtimeMaterializedRoot: groupClaudeConfigDir,
        sourceClaudeConfigDir: profileClaudeConfigDir,
      },
    });
    await expect(readFile(join(groupClaudeConfigDir, '.credentials.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forwards tracked Claude continuity hints into runtime-auth rematerialization', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
    const previousClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-previous-'));
    const vendorResumeId = '4b9434a8-b115-4363-851a-f39fff76a94b';
    const previousSessionPath = join(
      previousClaudeConfigDir,
      'projects',
      '-Users-leeroy-Documents-Development-happier-remote-dev',
      `${vendorResumeId}.jsonl`,
    );
    await mkdir(join(previousClaudeConfigDir, 'projects', '-Users-leeroy-Documents-Development-happier-remote-dev'), { recursive: true });
    await writeFile(previousSessionPath, '{"type":"assistant","message":"previous profile session"}\n');

    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_2',
      pid: 456,
      vendorResumeId,
      spawnOptions: {
        directory: '/Users/leeroy/Documents/Development/happier/remote-dev',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        resume: previousSessionPath,
        environmentVariables: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        },
      },
    };

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: currentGroupApi({ record, activeProfileId: 'backup', generation: 3 }),
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_2',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
        },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 3,
        credentialRevision: CURRENT_CREDENTIAL_REVISION,
        record,
      },
      accountSettings: accountSettingsParse({
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'shared' },
          },
          acknowledgedRisksByAgentId: {
            claude: { sharedStatePrivacy: true, symlinkUnavailable: true },
          },
        },
      }),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
    });

    const materializedEnv = (result as { targetMaterializedEnv?: Record<string, string> }).targetMaterializedEnv;
    expect(materializedEnv?.CLAUDE_CONFIG_DIR).toBeTruthy();
    await expect(verifyResumeReachableClaude({
      vendorResumeId,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: materializedEnv!.CLAUDE_CONFIG_DIR },
    })).resolves.toEqual({
      ok: true,
      resolvedPath: join(
        materializedEnv!.CLAUDE_CONFIG_DIR,
        'projects',
        '-Users-leeroy-Documents-Development-happier-remote-dev',
        `${vendorResumeId}.jsonl`,
      ),
    });
  });

  it('falls back to persisted session metadata for continuity hints when hooks have not reported', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
    const previousClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-previous-'));
    const vendorResumeId = '9d8b34a8-b115-4363-851a-f39fff76a94c';
    const previousSessionPath = join(
      previousClaudeConfigDir,
      'projects',
      '-Users-leeroy-Documents-Development-happier-remote-dev',
      `${vendorResumeId}.jsonl`,
    );
    await mkdir(dirname(previousSessionPath), { recursive: true });
    await writeFile(previousSessionPath, '{"type":"assistant","message":"persisted metadata session"}\n');
    mockFetchSessionByIdCompat.mockResolvedValueOnce({
      id: 'sess_persisted',
      encryptionMode: 'plain',
      seq: 1,
      metadata: JSON.stringify({
        claudeSessionId: vendorResumeId,
        claudeTranscriptPath: previousSessionPath,
      }),
    });

    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    };
    // The tracked session carries NO hook-reported continuity hints (early-turn failure /
    // daemon re-attach shape): no vendorResumeId, no resume spawn option, no webhook metadata.
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_persisted',
      pid: 789,
      spawnOptions: {
        directory: '/Users/leeroy/Documents/Development/happier/remote-dev',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        },
      },
    };

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: currentGroupApi({ record, activeProfileId: 'backup', generation: 3 }),
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_persisted',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
        },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 3,
        credentialRevision: CURRENT_CREDENTIAL_REVISION,
        record,
      },
      accountSettings: accountSettingsParse({
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'shared' },
          byAgentId: {
            claude: { configMode: 'copied', stateMode: 'shared' },
          },
          acknowledgedRisksByAgentId: {
            claude: { sharedStatePrivacy: true, symlinkUnavailable: true },
          },
        },
      }),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
    });

    const materializedEnv = (result as { targetMaterializedEnv?: Record<string, string> }).targetMaterializedEnv;
    expect(materializedEnv?.CLAUDE_CONFIG_DIR).toBeTruthy();
    await expect(verifyResumeReachableClaude({
      vendorResumeId,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: materializedEnv!.CLAUDE_CONFIG_DIR },
    })).resolves.toMatchObject({ ok: true });
  });

  it('isolates runtime rematerialization from stale target temp-file collisions by staging before replacement', async () => {
    const fixedUuid = 'runtime-write-failure';
    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      return {
        ...actual,
        randomUUID: () => fixedUuid,
      };
    });
    const runtimeAuthSelectionModule: typeof import('./materializeClaudeConnectedServiceRuntimeAuthSelection') =
      await import('./materializeClaudeConnectedServiceRuntimeAuthSelection');
    const {
      materializeClaudeConnectedServiceRuntimeAuthSelection: materializeWithFixedUuid,
    } = runtimeAuthSelectionModule;

    try {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
      const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
      const targetClaudeConfigDir = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'claude-subscription',
        '__groups',
        'work',
        'claude',
        'claude-config',
      );
      await mkdir(targetClaudeConfigDir, { recursive: true });
      await writeFile(
        join(targetClaudeConfigDir, '.credentials.json'),
        `${JSON.stringify({
          claudeAiOauth: {
            accessToken: 'stable-access-placeholder',
            refreshToken: 'stable-refresh-placeholder',
            expiresAt: 1_000,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
          },
        })}\n`,
      );
      await mkdir(join(targetClaudeConfigDir, `.credentials.${fixedUuid}.tmp`), { recursive: true });
      const record = buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'claude-subscription',
        profileId: 'backup',
        kind: 'oauth',
        expiresAt: 2_000,
        oauth: {
          accessToken: 'replacement-access-placeholder',
          refreshToken: 'replacement-refresh-placeholder',
          idToken: null,
          scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
          tokenType: 'Bearer',
          providerAccountId: 'provider-account',
          providerEmail: null,
        },
      });
      const previousBindings: ConnectedServiceBindingsV1 = {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'primary',
          },
        },
      };
      const normalizedBindings: ConnectedServiceBindingsV1 = {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'backup',
          },
        },
      };
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: sourceClaudeConfigDir,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          connectedServices: previousBindings,
          environmentVariables: {
            CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          },
        },
      };

      const result = await materializeWithFixedUuid({
        credentials: {
          token: 'token',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        } satisfies Credentials,
        api: currentGroupApi({ record, activeProfileId: 'backup', generation: 3 }),
        activeServerDir,
        input: {
        mode: 'apply',
        tracked,
          sessionId: 'sess_1',
          agentId: 'claude',
          serviceId: 'claude-subscription',
          previous: {
            source: 'connected',
            selection: 'group',
            serviceId: 'claude-subscription',
            profileId: 'primary',
            groupId: 'work',
          },
          next: {
            source: 'connected',
            selection: 'group',
            serviceId: 'claude-subscription',
            profileId: 'backup',
            groupId: 'work',
          },
          previousBindings,
          normalizedBindings,
          groupMetadata: {
            groupId: 'work',
            activeProfileId: 'backup',
            fallbackProfileId: 'fallback',
            generation: 3,
          },
        },
        baseSelection: {
          serviceId: 'claude-subscription',
          binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
          profileId: 'backup',
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
          credentialRevision: CURRENT_CREDENTIAL_REVISION,
          record,
        },
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      });

      expect(result).toEqual(expect.objectContaining({
        materializationDiagnostics: [],
      }));
      const replacedCredential = JSON.parse(await readFile(join(targetClaudeConfigDir, '.credentials.json'), 'utf8'));
      expect(replacedCredential.claudeAiOauth.accessToken).toBe('replacement-access-placeholder');
      expect(replacedCredential.claudeAiOauth).not.toHaveProperty('refreshToken');
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });
});
