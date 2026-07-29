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
  CODEX_SESSION_CONTROL_ADAPTER: Readonly<{
    normalizeRuntimeKindOverride?: (value: unknown) => unknown;
    applyRuntimeKindOverrideToAccountSettings?: (
      accountSettings: Record<string, unknown> | null,
      runtimeKind: 'acp' | 'appServer' | 'mcp',
    ) => Record<string, unknown> | null;
    resolveConfiguredRuntimeKind?: (accountSettings?: Record<string, unknown> | null) => unknown;
    resolvePersistedSessionRuntimeKind?: (metadata: unknown) => unknown;
    resolveVendorResumeId?: (metadata: unknown) => unknown;
    isExperimentalVendorResumeEnabled?: (input: Readonly<{
      metadata: unknown;
      accountSettings: Record<string, unknown> | null;
    }>) => boolean;
    isExperimentalVendorHandoffEnabled?: (input: Readonly<{
      metadata: unknown;
      accountSettings: Record<string, unknown> | null;
    }>) => boolean;
  }>;
  readCodexSessionMetadataRuntimeDescriptor: (metadata: Record<string, unknown>) => unknown;
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
        qualifiedPurposeMaterialization: true,
        openaiCodex: {
          kind: 'oauth',
          serviceId: 'openai-codex',
          oauth: {
            accessToken: 'legacy-coding-access',
            refreshToken: 'legacy-coding-refresh',
            idToken: 'legacy-coding-id',
            providerAccountId: 'legacy-coding-account',
          },
        },
        openai: {
          kind: 'token',
          serviceId: 'openai',
          token: {
            token: 'legacy-realtime-key',
          },
        },
      });

      expect(result.env).toEqual({ CODEX_HOME: codexHome });
      await expect(readFile(join(codexHome, 'auth.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
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

  it('exports plugin-owned session-control behavior for generated projection', () => {
    const adapter = moduleWithA16y3Exports.CODEX_SESSION_CONTROL_ADAPTER;

    expect(adapter?.normalizeRuntimeKindOverride?.('mcp')).toBe('appServer');
    expect(adapter?.normalizeRuntimeKindOverride?.('mcp_resume')).toBe('acp');
    expect(adapter?.applyRuntimeKindOverrideToAccountSettings?.({ keep: true }, 'acp')).toEqual({
      keep: true,
      codexBackendMode: 'acp',
    });
    expect(adapter?.applyRuntimeKindOverrideToAccountSettings?.({ keep: true }, 'server' as never)).toEqual({
      keep: true,
    });
    expect(adapter?.resolveConfiguredRuntimeKind?.({ experimentalCodexAcp: true })).toBe('appServer');
    expect(adapter?.resolveConfiguredRuntimeKind?.({ codexBackendMode: 'acp' })).toBe('acp');
    expect(adapter?.resolveConfiguredRuntimeKind?.({ codexBackendMode: 'mcp' })).toBe('appServer');
    expect(adapter?.resolvePersistedSessionRuntimeKind?.({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread-1',
        },
      },
    })).toBe('appServer');
    expect(adapter?.resolveVendorResumeId?.({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'legacy-thread',
        },
      },
    })).toBe('legacy-thread');
    expect(adapter?.isExperimentalVendorResumeEnabled?.({
      metadata: {},
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBe(true);
    expect(adapter?.isExperimentalVendorResumeEnabled?.({
      metadata: { codexBackendMode: 'mcp', codexSessionId: 'thread-1' },
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBe(false);
    expect(adapter?.isExperimentalVendorResumeEnabled?.({
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'mcp',
            providerSessionId: 'thread-1',
          },
        },
      },
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBe(false);
    expect(adapter?.isExperimentalVendorHandoffEnabled?.({
      metadata: { codexBackendMode: 'appServer' },
      accountSettings: null,
    })).toBe(true);
    expect(adapter?.isExperimentalVendorHandoffEnabled?.({
      metadata: { codexRuntimeDescriptorV1: { v: 1, backendMode: 'mcp' } },
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBe(false);
    expect(adapter?.isExperimentalVendorHandoffEnabled?.({
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'mcp',
            providerSessionId: 'thread-1',
          },
        },
      },
      accountSettings: { codexBackendMode: 'appServer' },
    })).toBe(false);
  });

  it('exports plugin-owned metadata reader behavior for generated projection', () => {
    expect(moduleWithA16y3Exports.readCodexSessionMetadataRuntimeDescriptor?.({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread-1',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceGroupId: 'group-1',
        },
      },
    })).toMatchObject({
      agentId: 'codex',
      runtimeKind: 'appServer',
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'group-1',
    });
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
