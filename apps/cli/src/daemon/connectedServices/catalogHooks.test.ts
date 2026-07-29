import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  getConnectedServiceRuntimeAuthAdapter,
  getConnectedServiceRecoveryCapabilities,
  getConnectedServicesMaterializer,
  getConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceCandidatePersistedSessionFile,
  resolveConnectedServiceSwitchContinuity,
  resolveConnectedServiceGenerationApplicationScope,
  resolveConnectedServiceRuntimeAuthApplyCapability,
} from './catalogHooks';

const EXPECTED_CLAUDE_RECOVERY_CAPABILITIES = {
  predictiveSoftSwitch: {
    mode: 'supported',
    liveSessionRequirement: {
      kind: 'shared_group_auth_surface',
      serviceIds: ['claude-subscription'],
      authEnvKey: 'CLAUDE_CONFIG_DIR',
      authEnvSubpath: ['claude-config'],
    },
  },
  sameAccountFanoutStrategy: 'shared_group_auth_surface',
  generationApplicationScope: 'shared_group_auth_surface',
  sharedGenerationApplicationServiceIds: ['claude-subscription'],
  runtimeAuthApply: {
    directLiveHotAuth: {
      supportsInTurnApply: false,
      requiresExactRuntimeIdentity: false,
      refreshSelectionResync: 'not_applicable',
      authMode: {
        kind: 'provider_owned',
        name: 'claude_shared_group_auth_surface',
      },
    },
  },
} as const;

const EXPECTED_CODEX_RECOVERY_CAPABILITIES = {
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
} as const;

describe('connected-service catalog hooks', () => {
  it('loads provider-owned connected-service hooks from the catalog owner', async () => {
    await expect(getConnectedServicesMaterializer('codex')).resolves.toBeTypeOf('function');
    await expect(getConnectedServiceRuntimeAuthAdapter('codex')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceStateSharingDescriptor('codex')).resolves.toMatchObject({
      providerId: 'codex',
      providerSupportStatus: 'supported',
    });
    await expect(getConnectedServiceRecoveryCapabilities('claude')).resolves.toEqual(
      EXPECTED_CLAUDE_RECOVERY_CAPABILITIES,
    );
    await expect(getConnectedServiceRecoveryCapabilities('codex')).resolves.toEqual(
      EXPECTED_CODEX_RECOVERY_CAPABILITIES,
    );
  });

  it('resolves generation application scope independently from quota identity fanout', async () => {
    await expect(resolveConnectedServiceGenerationApplicationScope('claude-subscription', 'claude')).resolves.toEqual({
      status: 'supported', scope: 'shared_group_auth_surface', ownerId: 'claude',
    });
    await expect(resolveConnectedServiceGenerationApplicationScope('openai-codex', 'codex')).resolves.toEqual({
      status: 'supported', scope: 'per_session_runtime', ownerId: 'codex',
    });
    await expect(resolveConnectedServiceGenerationApplicationScope('openai', 'opencode')).resolves.toEqual({
      status: 'supported', scope: 'request_time_auth', ownerId: 'opencode',
    });
  });

  it('keeps a capability load outage distinct from a loaded unsupported provider', async () => {
    await expect(resolveConnectedServiceRuntimeAuthApplyCapability(
      async () => {
        throw new Error('provider capability catalog temporarily unavailable');
      },
    )).rejects.toThrow('provider capability catalog temporarily unavailable');

    await expect(resolveConnectedServiceRuntimeAuthApplyCapability(
      async () => ({ predictiveSoftSwitch: { mode: 'unsupported' } }),
    )).resolves.toEqual({ directLiveHotAuth: 'unsupported' });
  });

  it('keeps unsupported continuity fail-closed when no provider hook exists', async () => {
    await expect(resolveConnectedServiceSwitchContinuity('kilo', {
      sessionId: 'session-1',
      agentId: 'kilo',
      serviceId: 'openai',
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'openai',
        profileId: null,
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'work',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'native' } } },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_unsupported',
    });
  });

  it('loads connected-service materializers for supporting providers', async () => {
    await expect(getConnectedServicesMaterializer('claude')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('codex')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('gemini')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('opencode')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('pi')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('ohMyPi')).resolves.toBeTypeOf('function');
  });

  it('resolves provider state sharing descriptors from provider-owned hooks', async () => {
    await expect(getConnectedServiceStateSharingDescriptor('codex')).resolves.toMatchObject({
      providerId: 'codex',
      providerSupportStatus: 'supported',
      config: {
        supported: true,
        modes: ['linked', 'copied', 'isolated'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'config.toml', mode: 'force_copied' }),
        ]),
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'sessions', mode: 'linked' }),
        ]),
      },
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: ['auth.json', 'accounts'],
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('claude')).resolves.toMatchObject({
      providerId: 'claude',
      providerSupportStatus: 'supported',
      state: {
        supported: true,
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'projects', mode: 'linked' }),
        ]),
        symlinkUnavailableDegradePolicy: 'block_continuity',
      },
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: expect.arrayContaining(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_API_KEY']),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('pi')).resolves.toMatchObject({
      providerId: 'pi',
      providerSupportStatus: 'supported',
      state: {
        supported: true,
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'sessions', mode: 'linked' }),
        ]),
      },
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: expect.arrayContaining(['auth.json']),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('gemini')).resolves.toMatchObject({
      providerId: 'gemini',
      providerSupportStatus: 'unsupported',
      authIsolation: {
        mode: 'process_env',
        secretEntries: expect.arrayContaining(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI']),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('opencode')).resolves.toMatchObject({
      providerId: 'opencode',
      providerSupportStatus: 'unsupported',
      authIsolation: {
        mode: 'process_env',
        secretEntries: expect.arrayContaining(['OPENCODE_AUTH_CONTENT', 'auth.json']),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('kilo')).resolves.toBeNull();
  });

  it('resolves provider-owned existing-session auth switch continuity through catalog hooks', async () => {
    const baseParams = {
      sessionId: 'sess_1',
      agentId: 'gemini' as const,
      serviceId: 'gemini' as const,
      fromBindings: { v: 1 as const, bindingsByServiceId: { gemini: { source: 'native' as const } } },
      toBindings: { v: 1 as const, bindingsByServiceId: { gemini: { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
      previousBinding: {
        source: 'native' as const,
        selection: 'native' as const,
        serviceId: 'gemini' as const,
        profileId: null,
        groupId: null,
      },
      nextBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'gemini' as const,
        profileId: 'work',
        groupId: null,
      },
    };

    await expect(resolveConnectedServiceSwitchContinuity('gemini', baseParams)).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'gemini_auth_environment_rematerialization_required',
    });
    const claudeParams = {
      ...baseParams,
      agentId: 'claude' as const,
      serviceId: 'anthropic' as const,
      previousBinding: { ...baseParams.previousBinding, serviceId: 'anthropic' as const },
      nextBinding: { ...baseParams.nextBinding, serviceId: 'anthropic' as const },
      fromBindings: { v: 1 as const, bindingsByServiceId: { anthropic: { source: 'native' as const } } },
      toBindings: { v: 1 as const, bindingsByServiceId: { anthropic: { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
    };
    await expect(resolveConnectedServiceSwitchContinuity('claude', claudeParams)).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'claude_session_state_sharing_required',
    });

    const codexRuntimeAuthSelection = {
      record: buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: 2,
        oauth: {
          accessToken: 'access',
          refreshToken: 'refresh',
          idToken: 'id',
          scope: null,
          tokenType: null,
          providerAccountId: 'acct',
          providerEmail: null,
        },
      }),
      applyConnectedServiceAuthGeneration: async () => ({ ok: true }),
      invalidateTransports: async () => {},
    };
    const codexNativeToConnectedParams = {
      ...baseParams,
      agentId: 'codex' as const,
      serviceId: 'openai-codex' as const,
      previousBinding: { ...baseParams.previousBinding, serviceId: 'openai-codex' as const },
      nextBinding: { ...baseParams.nextBinding, serviceId: 'openai-codex' as const },
      fromBindings: { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'native' as const } } },
      toBindings: { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
      runtimeAuthSelection: codexRuntimeAuthSelection,
    };
    await expect(resolveConnectedServiceSwitchContinuity('codex', codexNativeToConnectedParams)).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'codex_shared_state_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('codex', {
      ...codexNativeToConnectedParams,
      previousBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'openai-codex' as const,
        profileId: 'old',
        groupId: null,
      },
      fromBindings: { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'old' } } },
    })).resolves.toEqual({ mode: 'hot_apply' });
  });

  it('loads runtime auth adapters and predictive recovery capabilities from provider hooks', async () => {
    await expect(getConnectedServiceRuntimeAuthAdapter('claude')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('codex')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
      refreshActiveProfile: expect.any(Function),
    });
    const geminiAdapter = await getConnectedServiceRuntimeAuthAdapter('gemini');
    expect(geminiAdapter).toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      verifyProviderOutcome: expect.any(Function),
    });
    await expect(geminiAdapter?.verifyProviderOutcome?.({
      target: { agentId: 'gemini' },
      selections: [{
        kind: 'profile',
        serviceId: 'gemini',
        profileId: 'work',
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }],
      outcome: { kind: 'provider_activity', event: 'assistant_message_end' },
    })).resolves.toMatchObject({
      status: 'verified',
      targets: [expect.objectContaining({
        serviceId: 'gemini',
        profileId: 'work',
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      })],
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('antigravity')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      verifyProviderOutcome: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('opencode')).resolves.toBeNull();
    await expect(getConnectedServiceRuntimeAuthAdapter('pi')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('ohMyPi')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
      verifyProviderOutcome: expect.any(Function),
    });
    await expect(getConnectedServiceRecoveryCapabilities('claude')).resolves.toEqual(
      EXPECTED_CLAUDE_RECOVERY_CAPABILITIES,
    );
    await expect(getConnectedServiceRecoveryCapabilities('pi')).resolves.toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'request_time_auth',
    });
    await expect(getConnectedServiceRecoveryCapabilities('gemini')).resolves.toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'per_session_runtime',
    });
    await expect(getConnectedServiceRecoveryCapabilities('opencode')).resolves.toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'request_time_auth',
    });
    await expect(getConnectedServiceRecoveryCapabilities('codex')).resolves.toEqual(
      EXPECTED_CODEX_RECOVERY_CAPABILITIES,
    );
  });

  it('resolves provider-owned connected-service persisted session-file candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-catalog-candidate-'));
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      const piSessionFile = join(root, 'pi-agent-dir', 'sessions', '--tmp-project--', 'pi-session.jsonl');
      const codexSessionsRoot = join(root, 'codex-home', 'sessions');
      const codexRolloutFile = join(
        codexSessionsRoot,
        '2026',
        '06',
        '01',
        'rollout-2026-06-01T10-00-00-019e7cfd-2e3d-74f0-be76-b7459424f0a8.jsonl',
      );
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await mkdir(join(codexSessionsRoot, '2026', '06', '01'), { recursive: true });
      await writeFile(piSessionFile, '{}\n');
      await writeFile(codexRolloutFile, '{}\n');
      process.env.CODEX_HOME = join(root, 'codex-home');

      expect(resolveConnectedServiceCandidatePersistedSessionFile('pi', {
        piSessionFile,
      })).toBe(piSessionFile);
      expect(resolveConnectedServiceCandidatePersistedSessionFile('codex', {
        codexBackendMode: 'appServer',
        codexSessionId: '019e7cfd-2e3d-74f0-be76-b7459424f0a8',
      })).toBe(codexRolloutFile);
      expect(resolveConnectedServiceCandidatePersistedSessionFile('codex', {
        codexBackendMode: 'mcp',
        codexSessionId: '019e7cfd-2e3d-74f0-be76-b7459424f0a8',
      })).toBeNull();
      expect(resolveConnectedServiceCandidatePersistedSessionFile('claude', {
        piSessionFile,
      })).toBeNull();
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
