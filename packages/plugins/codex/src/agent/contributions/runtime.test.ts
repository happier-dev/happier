import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as runtimeContribution from './runtime.js';

type RuntimeControlMaterializeInput = Readonly<{
  runtimeControl: Readonly<{
    appServer: Readonly<{
      checkAvailable: () => Promise<Readonly<{ ok: true; value: true }>>;
      request: (input: Readonly<{ method: string; params?: unknown }>) => Promise<Readonly<{ ok: true; value: unknown }>>;
    }>;
    session: Readonly<{
      checkConnectedServiceAuthTransportInvalidation: () => Promise<Readonly<{ ok: true; value: true }>>;
      invalidateConnectedServiceAuthTransports: () => Promise<Readonly<{ ok: true; value: true }>>;
    }>;
    context: Readonly<{
      metadata?: unknown;
    }>;
  }>;
  params: Readonly<{
    input: Readonly<{ serviceId: string }>;
    baseSelection: Readonly<Record<string, unknown>>;
  }>;
}>;

type CodexRuntimeContributionModule = typeof runtimeContribution & Partial<{
  CODEX_AGENT_RUNTIME_CONTRIBUTION: Readonly<{
    connectedServices?: Readonly<{
      recoveryCapabilities?: unknown;
    }>;
    externalSessions?: Readonly<{
      createCandidateHostAdapter?: unknown;
      createTranscriptStoreAdapter?: unknown;
    }>;
    runtimeControl?: Readonly<{
      connectedServices?: Readonly<{
        createRuntimeAuthAdapter?: () => Readonly<{
          canHotApply?: (input: Readonly<{ target: Readonly<{ agentId: string }>; selection: unknown }>) => unknown;
        }>;
        materializeRuntimeAuthSelection?: (input: RuntimeControlMaterializeInput) => Promise<unknown>;
      }>;
    }>;
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
  it('declares the full provider-owned direct-live runtime auth capability', () => {
    expect(moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.connectedServices?.recoveryCapabilities)
      .toMatchObject({
        predictiveSoftSwitch: { mode: 'supported' },
        sameAccountFanoutStrategy: 'provider_account_id',
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

  it('exports host-mediated runtime-control hooks for generated projection', async () => {
    const runtimeControl = moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.runtimeControl;
    const adapter = runtimeControl?.connectedServices?.createRuntimeAuthAdapter?.();

    expect(runtimeControl?.appServer).toMatchObject({
      checkAvailable: expect.any(Function),
      request: expect.any(Function),
    });
    expect(adapter?.canHotApply?.({
      target: { providerId: 'codex' },
      selection: {
        record: { serviceId: 'openai-codex', kind: 'oauth', oauth: { providerAccountId: 'acct' } },
        invalidateTransports: async () => undefined,
      },
    })).toEqual({
      supported: true,
      mode: 'transport_recycle',
      recovery: 'restart_resume',
    });

    const selection = await runtimeControl?.connectedServices?.materializeRuntimeAuthSelection?.({
      runtimeControl: {
        context: { metadata: {} },
        appServer: {
          checkAvailable: async () => ({ ok: true, value: true }),
          request: async ({ method }) => ({ ok: true, value: { method } }),
        },
        session: {
          checkConnectedServiceAuthTransportInvalidation: async () => ({ ok: true, value: true }),
          invalidateConnectedServiceAuthTransports: async () => ({ ok: true, value: true }),
        },
      },
      params: {
        input: { serviceId: 'openai-codex' },
        baseSelection: {
          serviceId: 'openai-codex',
          profileId: 'work',
          record: { serviceId: 'openai-codex' },
        },
      },
    });

    expect(selection).toMatchObject({
      serviceId: 'openai-codex',
      client: { request: expect.any(Function) },
      invalidateTransports: expect.any(Function),
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

  it('exports public external-session host adapter factories from the runtime contribution', () => {
    const externalSessions = moduleWithA16y3Exports.CODEX_AGENT_RUNTIME_CONTRIBUTION?.externalSessions;

    expect(externalSessions?.createCandidateHostAdapter).toBeTypeOf('function');
    expect(externalSessions?.createTranscriptStoreAdapter).toBeTypeOf('function');
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
