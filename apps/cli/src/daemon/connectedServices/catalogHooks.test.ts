import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const acquireAuthoritativePluginRuntimeRegistryLease = vi.hoisted(() => vi.fn());
vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease,
}));

import {
  getConnectedServiceRuntimeAuthAdapter,
  getConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceSwitchContinuity,
  resolveConnectedServiceGenerationApplicationScope,
  resolveConnectedServicePredictiveSoftSwitchCapability,
} from './catalogHooks';

describe('connected-service catalog hooks', () => {
  let runtime!: ResolvedExecutablePluginRuntimeRegistry;

  beforeAll(async () => {
    runtime = await resolveExecutablePluginRuntimeRegistry({
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development',
        registeredRootId: `connected-service-catalog-test:${pluginId}`,
        canonicalRoot: rootPath,
        observedRevision: 1,
      }),
    });
    acquireAuthoritativePluginRuntimeRegistryLease.mockImplementation(async () => ({
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    }));
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  it.each([
    ['codex', 'happier.agent.codex/openai-codex', 'per_session_runtime'],
    ['ohMyPi', 'happier.agent.codex/openai-codex', 'per_session_runtime'],
    ['gemini', 'happier.agent.gemini/gemini-account', 'per_session_runtime'],
    ['pi', 'happier.agent.codex/openai-codex', 'request_time_auth'],
    ['claude', 'happier.agent.claude/claude-subscription', 'shared_group_auth_surface'],
  ] as const)('projects %s credential application from runtime auth rather than its native home', async (agentId, serviceId, scope) => {
    const application = await resolveConnectedServiceGenerationApplicationScope(serviceId, agentId);
    expect(application, JSON.stringify(runtime.pluginDiagnosticsByPluginId[`happier.agent.${agentId.toLowerCase()}`])).toEqual({
      status: 'supported', scope, ownerId: agentId,
    });
  });

  it.each([
    ['codex', 'happier.agent.codex/openai-codex', 'supported_in_turn'],
    ['ohMyPi', 'happier.agent.codex/openai-codex', 'unsupported'],
    ['gemini', 'happier.agent.gemini/gemini-account', 'unsupported'],
    ['pi', 'happier.agent.codex/openai-codex', 'supported'],
  ] as const)('projects %s predictive capability from live auth application rather than materialization', async (agentId, serviceId, expected) => {
    await expect(resolveConnectedServicePredictiveSoftSwitchCapability(agentId, {
      serviceId, groupId: 'pool', activeProfileId: 'work', profileId: 'work',
    })).resolves.toBe(expected);
  });

  it('loads focused Agent-auth hooks from the authoritative runtime catalog', async () => {
    await expect(getConnectedServiceRuntimeAuthAdapter('codex')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceStateSharingDescriptor('codex')).resolves.toMatchObject({
      providerId: 'codex',
      providerSupportStatus: 'supported',
    });
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
      fromBindings: { v: 2, bindingsByServiceId: { openai: { source: 'native' } } },
      toBindings: {
        v: 2,
        bindingsByServiceId: {
          openai: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_unsupported',
    });
  });

  it('resolves switch continuity from an external Agent current catalog declaration', async () => {
    acquireAuthoritativePluginRuntimeRegistryLease.mockImplementationOnce(async () => ({
      registry: {
        acquireAgentCatalogEntry: async () => ({
          id: 'acme.example-agent',
          cliSubcommand: 'acme.example-agent',
          connectedAccountServiceIds: ['com.acme.agent/acme-service'],
          connectedAccountSwitchContinuity: {
            continuityMode: 'restart_same_home',
            supportedTransitions: ['native_to_connected'],
          },
        }),
      },
      release: async () => {},
    }));

    await expect(resolveConnectedServiceSwitchContinuity('acme.example-agent' as never, {
      sessionId: 'session-external',
      agentId: 'acme.example-agent' as never,
      serviceId: 'com.acme.agent/acme-service' as never,
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'com.acme.agent/acme-service' as never,
        profileId: null,
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'com.acme.agent/acme-service' as never,
        profileId: 'work',
        groupId: null,
      },
      fromBindings: { v: 2, bindingsByServiceId: {} },
      toBindings: { v: 2, bindingsByServiceId: {} },
    })).resolves.toEqual({ mode: 'restart_same_home' });
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

  it('resolves existing-session auth switch continuity from the public Agent declaration', async () => {
    const baseParams = {
      sessionId: 'sess_1',
      agentId: 'gemini' as const,
      serviceId: 'happier.agent.gemini/gemini-account' as const,
      fromBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.gemini/gemini-account': { source: 'native' as const } } },
      toBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.gemini/gemini-account': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
      previousBinding: {
        source: 'native' as const,
        selection: 'native' as const,
        serviceId: 'happier.agent.gemini/gemini-account' as const,
        profileId: null,
        groupId: null,
      },
      nextBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'happier.agent.gemini/gemini-account' as const,
        profileId: 'work',
        groupId: null,
      },
    };

    await expect(resolveConnectedServiceSwitchContinuity('gemini', baseParams)).resolves.toEqual({
      mode: 'restart_same_home',
    });
    await expect(resolveConnectedServiceSwitchContinuity('gemini', {
      ...baseParams,
      previousBinding: { ...baseParams.previousBinding, source: 'connected', selection: 'group', profileId: 'old', groupId: 'pool' },
      nextBinding: { ...baseParams.nextBinding, selection: 'group', profileId: 'work', groupId: 'pool' },
      fromBindings: { v: 2, bindingsByServiceId: { 'happier.agent.gemini/gemini-account': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'old' } } },
      toBindings: { v: 2, bindingsByServiceId: { 'happier.agent.gemini/gemini-account': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'work' } } },
    })).resolves.toEqual({ mode: 'restart_same_home' });
    const claudeParams = {
      ...baseParams,
      agentId: 'claude' as const,
      serviceId: 'happier.agent.claude/anthropic' as const,
      previousBinding: { ...baseParams.previousBinding, serviceId: 'happier.agent.claude/anthropic' as const },
      nextBinding: { ...baseParams.nextBinding, serviceId: 'happier.agent.claude/anthropic' as const },
      fromBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.claude/anthropic': { source: 'native' as const } } },
      toBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.claude/anthropic': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
    };
    await expect(resolveConnectedServiceSwitchContinuity('claude', claudeParams)).resolves.toEqual({
      mode: 'restart_shared_state_required',
    });

    const codexNativeToConnectedParams = {
      ...baseParams,
      agentId: 'codex' as const,
      serviceId: 'happier.agent.codex/openai-codex' as const,
      previousBinding: { ...baseParams.previousBinding, serviceId: 'happier.agent.codex/openai-codex' as const },
      nextBinding: { ...baseParams.nextBinding, serviceId: 'happier.agent.codex/openai-codex' as const },
      fromBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'native' as const } } },
      toBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
    };
    await expect(resolveConnectedServiceSwitchContinuity('codex', codexNativeToConnectedParams)).resolves.toEqual({
      mode: 'hot_apply',
    });
    await expect(resolveConnectedServiceSwitchContinuity('codex', {
      ...codexNativeToConnectedParams,
      previousBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'happier.agent.codex/openai-codex' as const,
        profileId: 'old',
        groupId: null,
      },
      fromBindings: { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'old' } } },
    })).resolves.toEqual({ mode: 'hot_apply' });
  });

  it('loads focused runtime auth adapters from Agent registration', async () => {
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
    await expect(getConnectedServiceRuntimeAuthAdapter('antigravity')).resolves.toBeNull();
    await expect(getConnectedServiceRuntimeAuthAdapter('opencode')).resolves.toBeNull();
    await expect(getConnectedServiceRuntimeAuthAdapter('pi')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('ohMyPi')).resolves.toBeNull();
  });

});
