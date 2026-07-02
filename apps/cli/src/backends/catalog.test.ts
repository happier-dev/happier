import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from '@happier-dev/agents';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  AGENTS,
  getConnectedServiceStateSharingDescriptor,
  getConnectedServicesMaterializer,
  getConnectedServiceRuntimeAuthAdapter,
  getExternalSessionProviderOps,
  getManagedServerLaunchSpec,
  normalizeSessionControlPermissionModeForBackendTarget,
  getProviderAttachOps,
  getForkSurface,
  resolveBackendEngineAdapterResolution,
  getHandoffSurface,
  getConnectedServiceRecoveryCapabilities,
  getSessionUsageLimitRecoveryControlAdapter,
  getTerminalRuntimeOps,
  getVendorResumeSupport,
  requireCatalogEntry,
  resolveConnectedServiceCandidatePersistedSessionFile,
  resolveConnectedServiceSwitchContinuity,
} from './catalog';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { DEFAULT_CATALOG_AGENT_ID } from './types';

describe('AGENTS', () => {
  it('does not register Claude through the host built-in catalog', () => {
    const source = readFileSync(new URL('./builtInHostCatalogEntries.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/['"]\.\/claude['"]/);
  });

  it('does not keep the dead Claude host catalog wrapper', () => {
    expect(existsSync(new URL('./claude/index.ts', import.meta.url))).toBe(false);
  });

  it('does not keep Claude host CLI/preflight leaves replaced by plugin projection hooks', () => {
    for (const leafPath of [
      './claude/cli/capability.ts',
      './claude/cli/command.ts',
      './claude/cli/detect.ts',
      './claude/cli/auth/claudeCliAuthSpec.ts',
      './claude/cloud/authenticateClaudeSubscriptionOauth.ts',
      './claude/cloud/connect.ts',
      './claude/connectedServices/reportClaudeRuntimeAuthFailure.ts',
      './claude/preflight/claudePreflightModelsProbeAdapter.ts',
      './claude/sessionControls/probeClaudeHelpText.ts',
      './claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort.ts',
      './claude/startup/createClaudeDeferredStartupSession.ts',
      './claude/startup/synchronizeClaudeStartupOverrides.ts',
      './claude/terminalRuntime/claudeTerminalRuntimeOps.ts',
      './claude/ui/RemoteModeDisplay.tsx',
      './claude/ui/formatMessageForInk.ts',
      './claude/usage/publishAssistantUsage.ts',
    ]) {
      expect(existsSync(new URL(leafPath, import.meta.url))).toBe(false);
    }

    const claude = requireCatalogEntry('claude');
    expect(claude.getCliCapabilityOverride).toBeUndefined();
    expect(claude.getCliDetect).toBeTypeOf('function');
    expect(claude.getCloudConnectTarget).toBeTypeOf('function');
    expect(claude.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
  });

  it('does not keep the old Claude host runtime-plan owner after plugin runtime cutover', () => {
    for (const leafPath of [
      './claude/runtime/createSessionPlan.ts',
      './claude/runtime/createTurnOperations.ts',
      './claude/runtime/cleanupRuntimeAdjuncts.ts',
      './claude/runtime/resolveSessionLeaf.ts',
    ]) {
      expect(existsSync(new URL(leafPath, import.meta.url))).toBe(false);
    }
  });

  it('does not keep legacy Claude host terminal and remote launchers after plugin runtime cutover', () => {
    for (const leafPath of [
      './claude/runtime/remote/createBatchWaiter.ts',
      './claude/runtime/remote/createDispatchCallbacks.ts',
      './claude/runtime/remote/createLaunchController.ts',
      './claude/runtime/remote/createQueuedPromptCoordinator.ts',
      './claude/runtime/remote/createReadyHandler.ts',
      './claude/runtime/remote/dispatch.ts',
      './claude/runtime/remote/launcher.ts',
      './claude/runtime/remote/seedTeamInboxFromTranscriptPath.ts',
      './claude/runtime/terminal/createLaunchController.ts',
      './claude/runtime/terminal/launcher.ts',
      './claude/runtime/terminal/runTerminalSession.ts',
    ]) {
      expect(existsSync(new URL(leafPath, import.meta.url))).toBe(false);
    }
  });

  it('does not keep Claude host auth/spawn helpers now owned by plugin runtime leaves', () => {
    for (const leafPath of [
      './claude/auth/claudeAuthEnvKeys.ts',
      './claude/spawn/isolateClaudeRuntimeAuthEnv.ts',
      './claude/spawn/resolveClaudeCodeExperimentalEnvOverlay.ts',
      './claude/spawn/resolveClaudeRuntimeAuthEnvDiagnostic.ts',
    ]) {
      expect(existsSync(new URL(leafPath, import.meta.url))).toBe(false);
    }
  });

  it('does not keep dead Claude root host policies after plugin runtime cutover', () => {
    for (const leafPath of [
      './claude/claudeUnhandledRejectionPolicy.ts',
      './claude/sessionCaffeinatePolicy.ts',
    ]) {
      expect(existsSync(new URL(leafPath, import.meta.url))).toBe(false);
    }
  });

  it('does not keep the Codex B.7 CLI command wrapper in the host catalog entry', () => {
    const source = readFileSync(new URL('./codex/index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('getCliCommandHandler');
    expect(source).not.toContain('./cli/command');
  });

  it('does not keep the Codex B.7 daemon spawn wrapper in the host catalog entry', () => {
    const source = readFileSync(new URL('./codex/index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('getDaemonSpawnHooks');
    expect(source).not.toContain('./daemon/spawnHooks');
  });

  it('does not keep the Codex dynamic vendor-resume predicate in the host catalog entry', () => {
    const source = readFileSync(new URL('./codex/index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('getVendorResumeSupport');
    expect(source).not.toContain('supportsCodexVendorResume');
  });

  it('does not keep the Codex capability checklists in the host catalog entry', () => {
    const source = readFileSync(new URL('./codex/index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('codexChecklists');
    expect(source).not.toContain('checklists:');
  });

  it('includes kilo', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'kilo')).toBe(true);
  });

  it('includes pi', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'pi')).toBe(true);
  });

  it('includes ohMyPi', () => {
    expect(Object.prototype.hasOwnProperty.call(AGENTS, 'ohMyPi')).toBe(true);
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
    for (const id of AGENT_IDS) {
      const entry = requireCatalogEntry(id);
      expect(entry.vendorResumeSupport).toBe(getAgentCore(id).resume.vendorResume);
    }
  });

  it('resolves built-in ACP ohMyPi vendor resume support as enabled', async () => {
    const supportsResume = await getVendorResumeSupport('ohMyPi');
    expect(supportsResume({})).toBe(true);
  });

  it('allows daemon vendor-resume gating for runtime-checked experimental Cursor sessions', async () => {
    const supportsResume = await getVendorResumeSupport('cursor');
    expect(supportsResume({})).toBe(true);
  });

  it('keeps experimental vendor-resume providers without runtime checks disabled by default', async () => {
    const supportsResume = await getVendorResumeSupport('kiro');
    expect(supportsResume({})).toBe(false);
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
      const core = getAgentCore(id);
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

  it('declares opencode CLI model probing through the backend catalog', async () => {
    const entry = requireCatalogEntry('opencode');
    expect(entry.getPreflightSessionControlsProbeAdapter).toBeTypeOf('function');
    const adapter = await entry.getPreflightSessionControlsProbeAdapter!();
    expect(adapter).toMatchObject({
      failureCacheStrategy: 'cooldown',
      cliModelsCommandArgs: ['models'],
      verboseModelsCommandArgs: ['models', '--verbose'],
    });
  });

  it('does not define a headless tmux argv transform for codex', () => {
    expect(requireCatalogEntry('codex').getHeadlessTmuxArgvTransform).toBeUndefined();
  });

  it('registers runnable CLI command handlers for canonical built-in generic ACP agents', () => {
    expect(requireCatalogEntry('kiro').getCliCommandHandler).toBeTypeOf('function');
    expect(requireCatalogEntry('ohMyPi').getCliCommandHandler).toBeTypeOf('function');
  });

  it('loads direct-session provider ops through backend catalog hooks', async () => {
    await expect(getExternalSessionProviderOps('claude')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
      validateSource: expect.any(Function),
      getActivity: expect.any(Function),
      acquireFollowLease: expect.any(Function),
      resolveTakeoverSpawnOptions: expect.any(Function),
    });
    await expect(getExternalSessionProviderOps('codex')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      validateSource: expect.any(Function),
      acquireFollowLease: expect.any(Function),
    });
    await expect(getExternalSessionProviderOps('opencode')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
    });
    await expect(getExternalSessionProviderOps('ohMyPi')).resolves.toMatchObject({
      listCandidates: expect.any(Function),
      validateSource: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
      acquireFollowLease: expect.any(Function),
      resolveTakeoverSpawnOptions: expect.any(Function),
    });
  });

  it('loads connected-services materializers through backend catalog hooks for supporting providers', async () => {
    await expect(getConnectedServicesMaterializer('claude')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('codex')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('gemini')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('opencode')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('pi')).resolves.toBeTypeOf('function');
    await expect(getConnectedServicesMaterializer('ohMyPi')).resolves.toBeTypeOf('function');
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
    await expect(getConnectedServiceStateSharingDescriptor('kilo')).resolves.toBeNull();
    await expect(getConnectedServiceStateSharingDescriptor('claude')).resolves.toMatchObject({
      providerId: 'claude',
      providerSupportStatus: 'supported',
      config: {
        supported: true,
        modes: ['linked', 'copied', 'isolated'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'settings.json', mode: 'linked_or_copied' }),
          expect.objectContaining({ path: 'commands', mode: 'linked_or_copied' }),
        ]),
      },
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        entries: expect.arrayContaining([
          expect.objectContaining({ path: 'projects', mode: 'linked' }),
        ]),
        sharedStatePrivacyRiskAcknowledgementRequired: true,
        symlinkUnavailableDegradePolicy: 'block_continuity',
      },
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: expect.arrayContaining([
          'CLAUDE_CODE_OAUTH_TOKEN',
          'CLAUDE_CODE_SETUP_TOKEN',
          'CLAUDE_API_KEY',
          'ANTHROPIC_API_KEY',
          '.claude.json',
          '.credentials.json',
        ]),
      },
    });
    await expect(getConnectedServiceStateSharingDescriptor('pi')).resolves.toMatchObject({
      providerId: 'pi',
      providerSupportStatus: 'supported',
      state: {
        supported: true,
        modes: ['isolated', 'shared'],
        // D1: the PI session dir is shared via a cwd-encoded `linked` entry under
        // PI_CODING_AGENT_DIR; the descriptor must NOT request the legacy env-redirect
        // (PI_CODING_AGENT_SESSION_DIR) so D1 is enforced at the descriptor layer.
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
        mode: 'materialized_home',
        secretEntries: expect.arrayContaining(['.gemini/oauth_creds.json', '.gemini/google_accounts.json']),
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
      reason: 'gemini_restart_rematerialize_required',
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
    await expect(resolveConnectedServiceSwitchContinuity('claude', {
      ...claudeParams,
      vendorResumeId: 'claude-vendor-session-1',
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'claude_session_state_sharing_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('kilo', baseParams)).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_unsupported',
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
    const sameGroupContinuityContext = {
      connectedServiceMaterializationIdentityV1: {
        v: 1 as const,
        id: 'mat_1',
        createdAt: 1,
        source: 'tracked_spawn_options',
      },
      vendorResumeId: 'vendor-session-1',
    };
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'sess_1',
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
      ...sameGroupContinuityContext,
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'sess_1',
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
      ...sameGroupContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_session_state_sharing_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('pi', {
      sessionId: 'sess_1',
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
      ...sameGroupContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_session_state_sharing_required',
    });
    await expect(resolveConnectedServiceSwitchContinuity('opencode', {
      sessionId: 'sess_1',
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
      ...sameGroupContinuityContext,
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'opencode_restart_rematerialize_required',
    });
  });

  it('loads connected-service runtime auth adapters through backend catalog hooks for group-capable providers', async () => {
    await expect(getConnectedServiceRuntimeAuthAdapter('claude')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('codex')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
      refreshActiveProfile: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('gemini')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('opencode')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('pi')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
    await expect(getConnectedServiceRuntimeAuthAdapter('ohMyPi')).resolves.toMatchObject({
      classifyRuntimeAuthFailure: expect.any(Function),
      canHotApply: expect.any(Function),
    });
  });

  it('loads inactive usage-limit recovery control for providers with provider-owned recovery evidence', async () => {
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
    await expect(getSessionUsageLimitRecoveryControlAdapter('ohMyPi')).resolves.toBeNull();
  });

  it('declares predictive soft-switch recovery capabilities for restart-only providers', async () => {
    await expect(getConnectedServiceRecoveryCapabilities('claude')).resolves.toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
    });
    await expect(getConnectedServiceRecoveryCapabilities('pi')).resolves.toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
    });
    await expect(getConnectedServiceRecoveryCapabilities('gemini')).resolves.toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
    });
    // Codex declares no descriptor yet; consumers keep the legacy hot-apply adapter inference.
    await expect(getConnectedServiceRecoveryCapabilities('codex')).resolves.toBeNull();
  });

  it('loads managed-server launch specs through backend catalog hooks for supporting providers', async () => {
    await expect(getManagedServerLaunchSpec('opencode')).resolves.toMatchObject({
      command: expect.any(String),
      args: expect.any(Array),
    });
  });

  it('loads provider-attach ops through backend catalog hooks only for supporting providers', async () => {
    await expect(getProviderAttachOps('opencode')).resolves.toMatchObject({
      evaluateAvailability: expect.any(Function),
      attach: expect.any(Function),
    });
    await expect(getProviderAttachOps('claude')).resolves.toBeNull();
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

  it('resolves Codex fork through the plugin engine while preserving host-owned fork surfaces', async () => {
    const codexSource = readFileSync(new URL('./codex/index.ts', import.meta.url), 'utf8');
    expect(codexSource).not.toContain('getForkSurface');
    expect(codexSource).not.toContain('providerNativeForkHandler');

    const codexForkSurface = await getForkSurface('codex');
    expect(codexForkSurface).toMatchObject({
      fork: expect.any(Function),
    });
    expect(codexForkSurface).not.toHaveProperty('resolveReplayChildLaunch');
    expect(codexForkSurface).not.toHaveProperty('resolveAcpForkChildLaunch');

    const opencodeForkSurface = await getForkSurface('opencode');
    expect(opencodeForkSurface).toMatchObject({
      resolveReplayChildLaunch: expect.any(Function),
    });
    expect(opencodeForkSurface).not.toHaveProperty('fork');
    expect(opencodeForkSurface).not.toHaveProperty('resolveAcpForkChildLaunch');
    await expect(getForkSurface('claude')).resolves.toBeNull();
  });

  it('loads session-handoff provider ops through backend catalog hooks only for supporting providers', async () => {
    await expect(getHandoffSurface('claude')).resolves.toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(getHandoffSurface('codex')).resolves.toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(getHandoffSurface('opencode')).resolves.toMatchObject({
      exportBundle: expect.any(Function),
      importBundle: expect.any(Function),
    });
    await expect(getHandoffSurface('ohMyPi')).resolves.toBeNull();
  });

  it('normalizes session-control permission modes through provider-owned catalog seams', () => {
    expect(
      normalizeSessionControlPermissionModeForBackendTarget({
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'safe-yolo',
      }),
    ).toBe('acceptEdits');

    expect(
      normalizeSessionControlPermissionModeForBackendTarget({
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        permissionMode: 'safe-yolo',
      }),
    ).toBe('safe-yolo');
  });

  it('resolves built-in backends through the canonical engine-adapter record', async () => {
    const resolution = await resolveBackendEngineAdapterResolution('codex');
    expect(resolution).toMatchObject({
      backendId: 'codex',
      providerId: 'codex',
      provenance: 'first_party',
      backend: {
        id: 'codex',
      },
      provider: {
        id: 'codex',
      },
      executionSurfaces: {
        terminalRuntime: expect.anything(),
      },
      diagnostics: [],
    });
    expect(['system', 'managed', 'plugin']).toContain(resolution?.selectedSource);
  });
});
