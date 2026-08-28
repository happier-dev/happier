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
} from './catalogHooks';

describe('connected-service catalog hooks', () => {
  let runtime!: ResolvedExecutablePluginRuntimeRegistry;

  beforeAll(async () => {
    runtime = await resolveExecutablePluginRuntimeRegistry();
    acquireAuthoritativePluginRuntimeRegistryLease.mockImplementation(async () => ({
      registry: runtime,
      source: 'ephemeral',
      durableRevision: runtime.durableRevision ?? -1,
      release: async () => {},
    }));
  });

  afterAll(async () => {
    await runtime.dispose();
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
      fromBindings: { v: 1, bindingsByServiceId: {} },
      toBindings: { v: 1, bindingsByServiceId: {} },
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
    });

    const codexNativeToConnectedParams = {
      ...baseParams,
      agentId: 'codex' as const,
      serviceId: 'openai-codex' as const,
      previousBinding: { ...baseParams.previousBinding, serviceId: 'openai-codex' as const },
      nextBinding: { ...baseParams.nextBinding, serviceId: 'openai-codex' as const },
      fromBindings: { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'native' as const } } },
      toBindings: { v: 1 as const, bindingsByServiceId: { 'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' } } },
    };
    await expect(resolveConnectedServiceSwitchContinuity('codex', codexNativeToConnectedParams)).resolves.toEqual({
      mode: 'restart_shared_state_required',
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
    })).resolves.toEqual({ mode: 'restart_shared_state_required' });
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
