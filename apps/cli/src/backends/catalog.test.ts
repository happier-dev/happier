import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_IDS, DEFAULT_AGENT_ID } from '@happier-dev/agents';
import { AGENTS_CORE } from '@happier-dev/agents';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import * as catalog from './catalog';
import {
  AGENTS,
  getAcpForkContinuationHandler,
  getConnectedServiceMaterializer,
  getConnectedServiceStateSharingDescriptor,
  getDirectSessionProviderOps,
  getProviderAttachOps,
  getConnectedServiceRuntimeAuthAdapter,
  resolveConnectedServiceSwitchContinuity,
  getSessionUsageLimitRecoveryControlAdapter,
  getSessionGoalControlAdapter,
  getProviderNativeForkHandler,
  getVendorResumeSupport,
  requireCatalogEntry,
} from './catalog';
import { DEFAULT_CATALOG_AGENT_ID } from './types';

describe('AGENTS', () => {
  it('includes kilo', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'kilo')).toBe(true);
  });

  it('includes pi', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'pi')).toBe(true);
  });

  it('includes cursor', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'cursor')).toBe(true);
  });

  it('has unique cliSubcommand values', () => {
    const values = Object.values(AGENTS).map((entry) => entry.cliSubcommand);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keys match entry ids', () => {
    for (const [key, entry] of Object.entries(AGENTS)) {
      expect(key).toBe(entry.id);
    }
  });

  it('throws when requiring a missing catalog entry (no silent default fallback)', () => {
    expect(() => requireCatalogEntry('__missing__' as any)).toThrow(/missing catalog agent entry/i);
  });

  it('declares vendor resume support for every agent', () => {
    for (const entry of Object.values(AGENTS)) {
      expect(entry.vendorResumeSupport).toBeTruthy();
    }
  });

  it('matches shared agent ids', () => {
    const keys = Object.keys(AGENTS).slice().sort();
    const shared = [...AGENT_IDS].slice().sort();
    expect(keys).toEqual(shared);
  });

  it('uses the shared default agent id', () => {
    expect(DEFAULT_CATALOG_AGENT_ID).toBe(DEFAULT_AGENT_ID);
  });

  it('keeps cloud connect config in sync with catalog entries', async () => {
    for (const id of AGENT_IDS) {
      const core = AGENTS_CORE[id];
      const entry = requireCatalogEntry(id);

      if (core.cloudConnect) {
        expect(entry.getCloudConnectTarget).toBeTruthy();
        const target = await entry.getCloudConnectTarget!();
        expect(target.vendorKey).toBe(core.cloudConnect.vendorKey);
        expect(target.status).toBe(core.cloudConnect.status);
      } else {
        expect(entry.getCloudConnectTarget).toBeFalsy();
      }
    }
  });

  it('forces remote starting mode for claude headless tmux sessions', async () => {
    const transform = await requireCatalogEntry('claude').getHeadlessTmuxArgvTransform!();
    expect(transform(['--foo'])).toEqual(['--foo', '--happy-starting-mode', 'remote']);
  });

  it('exposes a preflight session-controls probe adapter for claude so model-scoped options can be surfaced without ACP', async () => {
    const entry = requireCatalogEntry('claude');
    expect(entry.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
    const adapter = await entry.getPreflightSessionControlsProbeAdapter!();
    expect(adapter).toMatchObject({
      probeModelsRaw: expect.any(Function),
    });
  });

  it('does not define a headless tmux argv transform for codex', () => {
    expect(requireCatalogEntry('codex').getHeadlessTmuxArgvTransform).toBeUndefined();
  });

  it('registers runnable CLI command handlers for built-in generic ACP agents', () => {
    expect(requireCatalogEntry('customAcp').getCliCommandHandler).toBeTypeOf('function');
    expect(requireCatalogEntry('kiro').getCliCommandHandler).toBeTypeOf('function');
  });

  it('registers Cursor through provider-owned ACP, auth, detect, and preflight hooks', async () => {
    const entry = requireCatalogEntry('cursor' as any);
    expect(entry).toMatchObject({
      id: 'cursor',
      cliSubcommand: 'cursor',
      vendorResumeSupport: 'experimental',
    });
    expect(entry.getCliAuthSpec).toBeTypeOf('function');
    expect(entry.getCliCapabilityOverride).toBeTypeOf('function');
    expect(entry.getCliDetect).toBeTypeOf('function');
    expect(entry.getAcpBackendFactory).toBeTypeOf('function');
    expect(entry.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
    expect(entry.needsAccountSettingsForProbes).toBe(true);

    await expect(entry.getPreflightSessionControlsProbeAdapter!()).resolves.toMatchObject({
      probeModelsRaw: expect.any(Function),
      probeModesRaw: expect.any(Function),
      cliModelsCommandArgs: ['models'],
      probeConfigOptionsRaw: expect.any(Function),
    });
  });

  it('allows daemon vendor-resume gating for runtime-checked experimental Cursor sessions', async () => {
    const support = await getVendorResumeSupport('cursor');

    expect(support({})).toBe(true);
  });

  it('keeps experimental vendor-resume providers without runtime checks disabled by default', async () => {
    const support = await getVendorResumeSupport('kiro');

    expect(support({})).toBe(false);
  });

  it('loads direct-session provider ops through backend catalog hooks', async () => {
    await expect(getDirectSessionProviderOps('claude')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
      getActivity: expect.any(Function),
      resolveTakeoverSpawnOptions: expect.any(Function),
    });
    await expect(getDirectSessionProviderOps('codex')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
    });
    await expect(getDirectSessionProviderOps('opencode')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
    });
  });

  it('loads provider-attach ops through backend catalog hooks only for supporting providers', async () => {
    await expect(getProviderAttachOps('opencode')).resolves.toMatchObject({
      evaluateEligibility: expect.any(Function),
      runAttach: expect.any(Function),
    });
    await expect(getProviderAttachOps('claude')).resolves.toBeNull();
  });

  it('loads connected-service runtime auth adapters through backend catalog hooks for supported providers', async () => {
    await expect(getConnectedServiceRuntimeAuthAdapter('codex')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('claude')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('opencode')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('gemini')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      probeQuota: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('pi')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('kilo')).resolves.toBeNull();
  });

  it('resolves provider credential lifecycle descriptors through backend catalog hooks with safe defaults', async () => {
    const catalogModule = catalog as unknown as Record<string, unknown>;
    expect(catalogModule.resolveConnectedServiceCredentialLifecycleDescriptor).toBeTypeOf('function');

    const resolveDescriptor =
      catalogModule.resolveConnectedServiceCredentialLifecycleDescriptor as (
        agentId: string,
      ) => Promise<unknown>;

    await expect(resolveDescriptor('claude')).resolves.toMatchObject({
      providerId: 'claude',
      serviceIds: expect.arrayContaining(['claude-subscription']),
      spawnPreflightOauthRefresh: { mode: 'force' },
      refreshedCredentialApplication: { mode: 'restart_required' },
    });
    await expect(resolveDescriptor('pi')).resolves.toMatchObject({
      providerId: 'pi',
      refreshedCredentialApplication: { mode: 'restart_required' },
    });
    await expect(resolveDescriptor('codex')).resolves.toMatchObject({
      providerId: 'codex',
      refreshedCredentialApplication: { mode: 'restart_required' },
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
    await expect(resolveDescriptor('gemini')).resolves.toEqual({
      providerId: 'gemini',
      serviceIds: ['gemini'],
      spawnPreflightOauthRefresh: { mode: 'expiry_window' },
      refreshedCredentialApplication: { mode: 'restart_required' },
      predictiveSoftSwitch: { mode: 'unsupported' },
      sameAccountFanoutStrategy: 'none',
      runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
    });
    await expect(resolveDescriptor('kilo')).resolves.toEqual({
      providerId: 'kilo',
      serviceIds: [],
      spawnPreflightOauthRefresh: { mode: 'expiry_window' },
      refreshedCredentialApplication: { mode: 'no_restart_required' },
      predictiveSoftSwitch: { mode: 'unsupported', liveSessionRequirement: { kind: 'none' } },
      sameAccountFanoutStrategy: 'none',
      runtimeAuthApply: { directLiveHotAuth: 'unsupported' },
    });
  });

  it('loads connected-service materializers through backend catalog hooks for providers that support connected services', async () => {
    await expect(getConnectedServiceMaterializer('codex')).resolves.toBeTypeOf('function');
    await expect(getConnectedServiceMaterializer('claude')).resolves.toBeTypeOf('function');
    await expect(getConnectedServiceMaterializer('opencode')).resolves.toBeTypeOf('function');
    await expect(getConnectedServiceMaterializer('pi')).resolves.toBeTypeOf('function');
    await expect(getConnectedServiceMaterializer('gemini')).resolves.toBeTypeOf('function');
    await expect(getConnectedServiceMaterializer('kilo')).resolves.toBeNull();
  });

  it('resolves connected-service state sharing descriptors through optional backend catalog hooks', async () => {
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
        sharedStatePrivacyRiskAcknowledgementRequired: true,
        symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
      },
      dynamicEntryPatterns: {
        sqlite: expect.objectContaining({
          scope: 'state',
          mode: 'linked',
        }),
      },
      transforms: expect.arrayContaining([
        expect.objectContaining({
          kind: 'rewrite_toml',
          entry: 'config.toml',
        }),
      ]),
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: ['auth.json', 'accounts'],
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('pi')).resolves.toMatchObject({
      providerId: 'pi',
      providerSupportStatus: 'supported',
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'sessions', mode: 'linked' }),
        ]),
      },
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: expect.arrayContaining(['auth.json']),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('kilo')).resolves.toBeNull();
    await expect(getConnectedServiceStateSharingDescriptor('claude')).resolves.toMatchObject({
      providerId: 'claude',
      providerSupportStatus: 'supported',
      config: {
        supported: true,
        modes: ['linked', 'copied', 'isolated'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'settings.json', mode: 'linked_or_copied' }),
        ]),
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'projects', mode: 'linked' }),
        ]),
      },
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: expect.arrayContaining(['CLAUDE_API_KEY']),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('gemini')).resolves.toMatchObject({
      providerId: 'gemini',
      providerSupportStatus: 'unsupported',
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: ['.gemini/oauth_creds.json'],
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('opencode')).resolves.toMatchObject({
      providerId: 'opencode',
      providerSupportStatus: 'unsupported',
      authIsolation: {
        mode: 'process_env',
        secretEntries: expect.arrayContaining(['OPENCODE_AUTH_CONTENT']),
      },
    });
  });

  it('resolves connected-service switch continuity through optional backend catalog hooks', async () => {
    const exactContinuityContext = {
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'materialization-session-1',
        createdAtMs: 1,
      },
      vendorResumeId: 'vendor-session-1',
    } as const;

    await expect(resolveConnectedServiceSwitchContinuity('kilo', {
      sessionId: 'session-1',
      agentId: 'kilo',
      serviceId: 'anthropic',
      previousBinding: null,
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'anthropic',
        profileId: 'work',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: {} },
      toBindings: { v: 1, bindingsByServiceId: {} },
    })).resolves.toEqual({ mode: 'unsupported', reason: 'provider_unsupported' });
    await expect(resolveConnectedServiceSwitchContinuity('claude', {
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'anthropic',
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'anthropic',
        profileId: null,
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'anthropic',
        profileId: 'work',
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'native' },
        },
      },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'claude_session_state_sharing_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('codex', {
      sessionId: 'session-1',
      agentId: 'codex',
      serviceId: 'openai-codex',
      previousBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai-codex',
        profileId: 'old',
        groupId: 'team',
      },
      nextBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai-codex',
        profileId: 'new',
        groupId: 'team',
      },
      fromBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'team', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'team', profileId: 'new' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
    await expect(resolveConnectedServiceSwitchContinuity('codex', {
      sessionId: 'session-1',
      agentId: 'codex',
      serviceId: 'openai-codex',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new' } } },
    })).resolves.toEqual({ mode: 'restart_shared_state_required', reason: 'codex_shared_state_required' });
    await expect(resolveConnectedServiceSwitchContinuity('codex', {
      sessionId: 'session-1',
      agentId: 'codex',
      serviceId: 'openai-codex',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new' } } },
      runtimeAuthSelection: {
        record: buildConnectedServiceCredentialRecord({
          now: 1,
          serviceId: 'openai-codex',
          profileId: 'new',
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
        persistAuthStore: async () => {},
      },
    })).resolves.toEqual({ mode: 'hot_apply' });
    await expect(resolveConnectedServiceSwitchContinuity('codex', {
      sessionId: 'session-1',
      agentId: 'codex',
      serviceId: 'openai-codex',
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai-codex',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'native' } } },
      toBindings: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new' } } },
      runtimeAuthSelection: {
        record: buildConnectedServiceCredentialRecord({
          now: 1,
          serviceId: 'openai-codex',
          profileId: 'new',
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
        invalidateTransports: async () => {},
      },
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'codex_shared_state_required',
    });

    const piRoot = await mkdtemp(join(tmpdir(), 'happier-pi-catalog-continuity-'));
    const piSessionFile = join(
      piRoot,
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-05-27T00-00-00-000Z_vendor-session-1.jsonl',
    );
    await mkdir(join(piRoot, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
    await writeFile(piSessionFile, '{}\n');
    const piReachableContext = {
      ...exactContinuityContext,
      targetMaterializedRoot: piRoot,
      targetMaterializedEnv: {
        PI_CODING_AGENT_DIR: join(piRoot, 'pi-agent-dir'),
      },
      cwd: '/tmp/project',
      candidatePersistedSessionFile: piSessionFile,
    } as const;

    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'new' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_exact_connected_service_selection_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai',
        profileId: 'old',
        groupId: 'team',
      },
      nextBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai',
        profileId: 'new',
        groupId: 'team',
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'group', profileId: 'old', groupId: 'team' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'group', profileId: 'new', groupId: 'team' } } },
      ...piReachableContext,
    })).resolves.toEqual({ mode: 'restart_same_home' });
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'same',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'same',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'same' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'same' } } },
      ...piReachableContext,
    })).resolves.toEqual({ mode: 'restart_same_home' });
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'session-1',
      agentId: 'pi',
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
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'native' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'new' } } },
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_session_state_sharing_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'session-1',
      agentId: 'pi',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'openai',
        profileId: null,
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'native' } } },
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_session_state_sharing_required',
    });
    await rm(piRoot, { recursive: true, force: true });
    await expect(resolveConnectedServiceSwitchContinuity('gemini', {
      sessionId: 'session-1',
      agentId: 'gemini',
      serviceId: 'gemini',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'gemini',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'gemini',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { gemini: { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { gemini: { source: 'connected', selection: 'profile', profileId: 'new' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'gemini_restart_rematerialize_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'session-1',
      agentId: 'opencode',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'new' } } },
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'session-1',
      agentId: 'opencode',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai',
        profileId: 'old',
        groupId: 'team',
      },
      nextBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'openai',
        profileId: 'new',
        groupId: 'team',
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'group', profileId: 'old', groupId: 'team' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'group', profileId: 'new', groupId: 'team' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'session-1',
      agentId: 'opencode',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'new' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'session-1',
      agentId: 'opencode',
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
        profileId: 'new',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'native' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'new' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'session-1',
      agentId: 'opencode',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'old',
        groupId: null,
      },
      nextBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'openai',
        profileId: null,
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'old' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'native' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'session-1',
      agentId: 'opencode',
      serviceId: 'openai',
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'same',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'openai',
        profileId: 'same',
        groupId: null,
      },
      fromBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'same' } } },
      toBindings: { v: 1, bindingsByServiceId: { openai: { source: 'connected', selection: 'profile', profileId: 'same' } } },
      ...exactContinuityContext,
    })).resolves.toEqual({
      // Identical re-selection routes through the same restart/rematerialize action as changed
      // selections: OpenCode session state is global, not home-scoped (RD-OPI-4).
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
  });

  it('loads Codex inactive goal control through the backend catalog hook', async () => {
    await expect(getSessionGoalControlAdapter('codex')).resolves.toMatchObject({
      setGoal: expect.any(Function),
      clearGoal: expect.any(Function),
    });
    await expect(getSessionGoalControlAdapter('claude')).resolves.toBeNull();
  });

  it('loads inactive usage-limit recovery control for supported providers', async () => {
    await expect(getSessionUsageLimitRecoveryControlAdapter('codex')).resolves.toMatchObject({
      checkNow: expect.any(Function),
    });
    await expect(getSessionUsageLimitRecoveryControlAdapter('gemini')).resolves.toMatchObject({
      checkNow: expect.any(Function),
    });
    await expect(getSessionUsageLimitRecoveryControlAdapter('opencode')).resolves.toMatchObject({
      checkNow: expect.any(Function),
    });
    await expect(getSessionUsageLimitRecoveryControlAdapter('claude')).resolves.toMatchObject({
      checkNow: expect.any(Function),
    });
    await expect(getSessionUsageLimitRecoveryControlAdapter('pi')).resolves.toMatchObject({
      checkNow: expect.any(Function),
    });
  });

  it('loads provider-native fork handlers through backend catalog hooks only for supporting providers', async () => {
    await expect(getProviderNativeForkHandler('codex')).resolves.toBeTypeOf('function');
    await expect(getProviderNativeForkHandler('opencode')).resolves.toBeTypeOf('function');
    await expect(getProviderNativeForkHandler('claude')).resolves.toBeNull();
  });

  it('loads ACP fork continuation handlers through backend catalog hooks only for supporting providers', async () => {
    await expect(getAcpForkContinuationHandler('codex')).resolves.toBeTypeOf('function');
    await expect(getAcpForkContinuationHandler('opencode')).resolves.toBeTypeOf('function');
    await expect(getAcpForkContinuationHandler('claude')).resolves.toBeNull();
  });
});
