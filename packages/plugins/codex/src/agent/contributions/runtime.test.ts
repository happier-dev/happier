import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import * as runtimeContribution from './runtime.js';

type CodexRuntimeContributionModule = typeof runtimeContribution & Partial<{
  CODEX_AGENT_RUNTIME_CONTRIBUTION: Readonly<{
    agentCliSystemTool?: Readonly<{
      toolId?: unknown;
    }>;
    sessionStartup?: Readonly<{
      shouldUseDeferredBootstrap?: (params: Readonly<{
        startedBy: 'terminal' | 'daemon';
        startingMode: 'terminal' | 'remote' | 'local' | null;
        existingSessionId: string | null;
        sessionAttachFilePath: string | null;
        providerResumeId: string | null;
        hasExplicitPermissionMode: boolean;
        permissionModeSeedSource: 'explicit' | 'inferred' | 'account_default' | 'fallback' | 'released_cache_v1';
        hasTerminalTty: boolean;
      }>) => boolean;
    }>;
    connectedServices?: Readonly<{
      recoveryCapabilities?: unknown;
      resolveLegacyRuntimeAuthFailureSourceRevision?: unknown;
      runtimeAuthAdapter?: Readonly<{
        canHotApply?: (input: Readonly<{ target: Readonly<{ agentId: string }>; selection: unknown }>) => unknown;
      }>;
      verifyResumeReachable?: unknown;
      resolveCandidatePersistedSessionFile?: unknown;
    }>;
    sessionHandoff?: Readonly<{
      surface?: () => Readonly<{
        exportBundle?: unknown;
        importBundle?: unknown;
      }>;
    }>;
    runtimeControl?: unknown;
  }>;
  buildCodexAgentRuntimeDescriptorV1: (params: Readonly<{
    backendMode: 'acp' | 'appServer';
    providerSessionId?: string | null;
    home?: 'user' | 'connectedService' | null;
    connectedServiceId?: string | null;
    connectedServiceProfileId?: string | null;
    connectedServiceGroupId?: string | null;
    homePath?: string | null;
  }>) => unknown;
  readCanonicalCodexAgentRuntimeDescriptorV1: (descriptor: unknown) => unknown;
}>;

const moduleWithA16y3Exports = runtimeContribution as CodexRuntimeContributionModule;

describe('Codex runtime contribution leaves', () => {
  it('binds the manifest-declared Codex CLI system tool to the Agent runtime', () => {
    const codexCliSystemTool = PLUGIN_MANIFEST.contributes.systemTools?.find(
      (systemTool) => systemTool.id === 'codex-cli',
    );

    expect(codexCliSystemTool).toBeDefined();
    expect(moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.agentCliSystemTool).toEqual({
      toolId: codexCliSystemTool?.id,
    });
  });

  it.each([
    {
      name: 'fresh implicit terminal TTY start',
      input: {
        startedBy: 'terminal' as const,
        startingMode: null,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: null,
        hasExplicitPermissionMode: false,
        permissionModeSeedSource: 'fallback' as const,
        hasTerminalTty: true,
      },
      expected: true,
    },
    {
      name: 'explicit local provider resume with a permission seed',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'local' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: 'codex-thread',
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: true,
      },
      expected: true,
    },
    {
      name: 'provider resume with the released V1 cache seed',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: 'codex-thread',
        hasExplicitPermissionMode: false,
        permissionModeSeedSource: 'released_cache_v1' as const,
        hasTerminalTty: true,
      },
      expected: true,
    },
    {
      name: 'provider resume without an explicit permission seed',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: 'codex-thread',
        hasExplicitPermissionMode: false,
        permissionModeSeedSource: 'fallback' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'provider resume with a canonical account-default seed',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: 'codex-thread',
        hasExplicitPermissionMode: false,
        permissionModeSeedSource: 'account_default' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'existing Happier resume',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: 'happy-session',
        sessionAttachFilePath: '/tmp/session-attach.json',
        providerResumeId: 'codex-thread',
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'non-TTY start',
      input: {
        startedBy: 'terminal' as const,
        startingMode: null,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: null,
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: false,
      },
      expected: false,
    },
    {
      name: 'daemon start',
      input: {
        startedBy: 'daemon' as const,
        startingMode: 'terminal' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: null,
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
  ])('owns deferred startup eligibility for $name', ({ input, expected }) => {
    expect(
      moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION
        ?.sessionStartup
        ?.shouldUseDeferredBootstrap?.(input),
    ).toBe(expected);
  });

  it('keeps predecessor failure-source evidence in the Codex provider leaf', () => {
    expect(
      moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.connectedServices
        ?.resolveLegacyRuntimeAuthFailureSourceRevision,
    ).toBeTypeOf('function');
  });

  it('publishes the native handoff surface through the generated Agent contribution', () => {
    expect(moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.sessionHandoff?.surface?.())
      .toMatchObject({
        exportBundle: expect.any(Function),
        importBundle: expect.any(Function),
      });
  });

  it('declares the provider-owned in-turn hot-auth capability that its routable runtime implements', () => {
    expect(moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.connectedServices?.recoveryCapabilities)
      .toMatchObject({
        predictiveSoftSwitch: { mode: 'supported' },
        sameAccountFanoutStrategy: 'provider_account_id',
        generationApplicationScope: 'per_session_runtime',
        runtimeAuthApply: {
          directLiveHotAuth: {
            supportsInTurnApply: true,
            requiresExactRuntimeIdentity: true,
            refreshSelectionResync: 'required',
            authMode: {
              kind: 'external_token_injection',
              surface: 'codex_chatgpt_auth_tokens',
            },
          },
        },
      });
  });

  it('materializes openai-codex auth.json with private atomic-file permissions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-auth-materialize-'));
    try {
      await runtimeContribution.materializeCodexAuthEnvironment({
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        rootDir: codexHome,
        openaiCodex: {
          kind: 'oauth',
          serviceId: 'openai-codex',
          oauth: {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            idToken: 'id-token',
            providerAccountId: 'account-1',
          },
        },
      });

      const authPath = join(codexHome, 'auth.json');
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        auth_mode: 'chatgpt',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: 'id-token',
        account_id: 'account-1',
      });
      if (process.platform !== 'win32') {
        expect((await stat(authPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('materializes only the primary Codex OAuth source when a secondary OpenAI key is also present', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-dual-auth-materialize-'));
    try {
      const result = await runtimeContribution.materializeCodexAuthEnvironment({
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        rootDir: codexHome,
        openaiCodex: {
          kind: 'oauth',
          serviceId: 'openai-codex',
          oauth: {
            accessToken: 'coding-access-token',
            refreshToken: 'coding-refresh-token',
            idToken: 'coding-id-token',
            providerAccountId: 'coding-account',
          },
        },
        openai: {
          kind: 'token',
          serviceId: 'openai',
          token: {
            token: 'sk-realtime-account',
          },
        },
      });

      expect(result.env).toEqual({ CODEX_HOME: codexHome });
      expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'))).toMatchObject({
        auth_mode: 'chatgpt',
        access_token: 'coding-access-token',
        account_id: 'coding-account',
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('leaves current qualified purpose credentials to the canonical Connected Accounts owner', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-qualified-materialize-'));
    try {
      const result = await runtimeContribution.materializeCodexAuthEnvironment({
        rootDir: codexHome,
        connectedAccountMaterializationAuthority: 'qualified',
      });

      expect(result.env).toEqual({ CODEX_HOME: codexHome });
      await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('uses one source SQLite home for shared state and the materialized home for isolated state', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-sqlite-materialize-'));
    try {
      const sourceSqliteHome = join(codexHome, 'source-sqlite');
      const processEnv = {
        CODEX_HOME: join(codexHome, 'source-codex'),
        CODEX_SQLITE_HOME: sourceSqliteHome,
      };

      const shared = await runtimeContribution.materializeCodexAuthEnvironment({
        rootDir: codexHome,
        connectedAccountMaterializationAuthority: 'qualified',
        connectedServicesSessionStateSharingEffectiveMode: 'shared',
        processEnv,
      });
      const isolated = await runtimeContribution.materializeCodexAuthEnvironment({
        rootDir: codexHome,
        connectedAccountMaterializationAuthority: 'qualified',
        connectedServicesSessionStateSharingEffectiveMode: 'isolated',
        processEnv,
      });

      expect(shared.env.CODEX_SQLITE_HOME).toBe(sourceSqliteHome);
      expect(isolated.env.CODEX_SQLITE_HOME).toBe(codexHome);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('fails closed when the host omits or malforms connected-account materialization authority', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-missing-authority-'));
    try {
      for (const authority of [undefined, 'unqualified'] as const) {
        await expect(runtimeContribution.materializeCodexAuthEnvironment({
          ...(authority === undefined
            ? {}
            : { connectedAccountMaterializationAuthority: authority }),
          rootDir: codexHome,
          openai: {
            kind: 'token',
            serviceId: 'openai',
            token: {
              token: 'must-not-reach-codex',
            },
          },
        })).rejects.toThrow(/materialization authority/i);
      }

      await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('rejects request-auth input on the exact legacy one-shot authority', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-legacy-request-auth-'));
    try {
      await expect(runtimeContribution.materializeCodexAuthEnvironment({
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        requestAuth: { purposeBindings: [] },
        rootDir: codexHome,
        openai: {
          kind: 'token',
          serviceId: 'openai',
          token: {
            token: 'must-not-reach-codex',
          },
        },
      })).rejects.toThrow(/request auth/i);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('requires restart/rematerialization when either Codex process-scoped auth selection changes', () => {
    const policy = moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.connectedServices as
      | Readonly<{ shouldRestartForServiceSwitch?: (selection: unknown) => boolean }>
      | undefined;

    expect(policy?.shouldRestartForServiceSwitch?.('openai-codex')).toBe(true);
    expect(policy?.shouldRestartForServiceSwitch?.('openai')).toBe(true);
    expect(policy?.shouldRestartForServiceSwitch?.('anthropic')).toBe(false);
  });

  it('exports native connected-service policy without a reflective runtime-control row', () => {
    const contribution = moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION;
    const connectedServices = contribution?.connectedServices;
    const adapter = connectedServices?.runtimeAuthAdapter;

    expect(contribution).not.toHaveProperty('runtimeControl');
    expect(connectedServices?.verifyResumeReachable).toEqual(expect.any(Function));
    expect(connectedServices?.resolveCandidatePersistedSessionFile).toEqual(expect.any(Function));
    expect(adapter?.canHotApply?.({
      target: { agentId: 'codex' },
      selection: {
        record: { serviceId: 'openai-codex', kind: 'oauth', oauth: { providerAccountId: 'acct' } },
      },
    })).toEqual({
      supported: false,
      reason: 'runtime_apply_callback_unavailable',
    });
  });

  it('does not export retired raw Session metadata owners', () => {
    expect(moduleWithA16y3Exports).not.toHaveProperty('CODEX_SESSION_CONTROL_ADAPTER');
    expect(moduleWithA16y3Exports).not.toHaveProperty('readCodexSessionMetadataRuntimeDescriptor');
  });

  it('does not retain the superseded internal external-session carrier', () => {
    expect(moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION)
      .not.toHaveProperty('externalSessions');
  });

  it('exports plugin-owned protocol descriptor functions for generated projection', () => {
    const descriptor = moduleWithA16y3Exports.buildCodexAgentRuntimeDescriptorV1?.({
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
      homePath: '/tmp/codex-home',
    });

    expect(moduleWithA16y3Exports.readCanonicalCodexAgentRuntimeDescriptorV1?.(descriptor)).toEqual({
      agentId: 'codex',
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
      homePath: '/tmp/codex-home',
    });
  });
});
