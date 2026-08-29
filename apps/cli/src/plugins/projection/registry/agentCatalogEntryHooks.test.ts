import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentCliSessionCommandDeclarationV1,
  AgentCliSessionCommandBuildInputV1,
  AgentConnectedAccountRuntimeAuthAdapterV1,
  AgentPreflightSessionControlsContributionV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import {
  createCliSessionCommandHandler,
  projectAgentCliSessionCommandCatalogEntry,
  projectAgentConnectedAccountLaunchCatalogEntry,
  projectAgentDaemonSpawnHooksCatalogEntry,
  projectAgentExperimentalVendorResumeSupportCatalogEntry,
  projectAgentPreflightSessionControlsCatalogEntry,
  projectAgentSessionStartupCatalogEntry,
} from './agentCatalogEntryHooks';

const runBackendSessionCliCommandMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => undefined),
);
vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

describe('Agent registration catalog projections', () => {
  beforeEach(() => {
    runBackendSessionCliCommandMock.mockClear();
  });

  it('projects the exact registered daemon-spawn hook', async () => {
    const hooks = Object.freeze({ augmentEnv: () => ({ ACME: '1' }) });
    await expect(
      projectAgentDaemonSpawnHooksCatalogEntry(hooks).getDaemonSpawnHooks?.(),
    ).resolves.toBe(hooks);
  });

  it('fences deferred-startup and experimental resume callbacks to their generation', async () => {
    const shouldUseDeferredBootstrap = vi.fn(() => true);
    const supportsVendorResume = vi.fn(() => true);
    let current = true;
    const startup = projectAgentSessionStartupCatalogEntry({
      sessionStartup: { shouldUseDeferredBootstrap },
      isCurrent: () => current,
    });
    const resume = projectAgentExperimentalVendorResumeSupportCatalogEntry({
      vendorResumeSupport: { supportsVendorResume },
      isCurrent: () => current,
    });
    const input = {
      startedBy: 'terminal' as const,
      startingMode: 'terminal' as const,
      hasExistingSession: false,
      hasSessionAttachFile: false,
      hasProviderResumeId: false,
      hasExplicitPermissionMode: false,
      hasPersistedPermissionModeSeed: false,
      hasTerminalTty: true,
    };
    const supportsResume = await resume.getVendorResumeSupport?.();

    expect(startup.shouldUseDeferredSessionStartup?.(input)).toBe(true);
    expect(supportsResume?.({ agentRuntimeSelection: { mode: 'acp' } })).toBe(true);
    current = false;
    expect(startup.shouldUseDeferredSessionStartup?.(input)).toBe(false);
    expect(supportsResume?.({ agentRuntimeSelection: { mode: 'acp' } })).toBe(false);
    expect(shouldUseDeferredBootstrap).toHaveBeenCalledTimes(1);
    expect(supportsVendorResume).toHaveBeenCalledTimes(1);
  });

  it('projects Connected Account launch facts and fences continuity callbacks to their generation', async () => {
    let current = true;
    let settleReachability!: (value: Readonly<{ ok: true }>) => void;
    const verifyResumeReachable = vi.fn(() => new Promise<Readonly<{ ok: true }>>((resolve) => {
      settleReachability = resolve;
    }));
    const projected = projectAgentConnectedAccountLaunchCatalogEntry({
      agentId: 'acme.external' as never,
      isCurrent: () => current,
      hostAccess: {
        required: [{
          id: 'external-agent-process',
          capability: 'process',
          reason: 'Launch the external Agent with its selected account environment.',
          scope: {
            executables: [{ kind: 'systemTool', id: 'external-agent-cli' }],
            envKeys: ['ACME_CONFIG_DIR'],
          },
        }],
        optional: [],
      },
      connectedAccountLaunch: {
        switchContinuity: {
          continuityMode: 'restart_same_home',
          supportedTransitions: ['native_to_connected'],
        },
        requestAuthUses: [{
          purpose: 'model_upstream',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
          },
        }],
        stateSharingDescriptor: {
          providerSupportStatus: 'supported',
          config: { supported: true, modes: ['linked'], entries: [] },
          state: {
            supported: true,
            modes: ['isolated'],
            entries: [],
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'materialized_home', secretEntries: [] },
          nativeHome: {
            environmentKey: 'ACME_CONFIG_DIR',
            defaultRelativePath: '.acme',
          },
        },
        continuity: {
          verifyResumeReachable,
        },
      },
    });

    expect(projected.connectedAccountRequestAuthUses).toHaveLength(1);
    expect(projected.connectedAccountSwitchContinuity).toEqual({
      continuityMode: 'restart_same_home',
      supportedTransitions: ['native_to_connected'],
    });
    await expect(projected.getConnectedServiceStateSharingDescriptor?.()).resolves.toMatchObject({
      providerId: 'acme.external',
      providerSupportStatus: 'supported',
    });
    expect(projected).not.toHaveProperty('getConnectedServicesMaterializer');
    expect(projected).not.toHaveProperty('resolveConnectedServiceMaterializedHomeRoot');

    const late = projected.verifyResumeReachable?.({
      vendorResumeId: 'vendor-1',
      sessionFiles: {
        findDeclaredCandidate: async () => ({ found: true }),
      },
    });
    current = false;
    settleReachability({ ok: true });
    await expect(late).resolves.toEqual({
      ok: false,
      reason: 'plugin_generation_retired',
    });
    expect(verifyResumeReachable).toHaveBeenCalledTimes(1);
  });

  it('keeps credential, declared-file, and currentness custody behind typed native-auth operations', async () => {
    const materialize = vi.fn(({ credential, selection }) => ({
      files: {
        'auth.json': new TextEncoder().encode(JSON.stringify({
          profileId: credential.profileId,
          generation: selection.generation,
        })),
      },
    }));
    const inspect = vi.fn(({ credential, files }) => ({
      status: 'verified' as const,
      providerAccountId: credential.kind === 'oauth'
        ? credential.oauth.providerAccountId
        : null,
      source: new TextDecoder().decode(files['auth.json']),
    }));
    const hotApply = vi.fn<AgentConnectedAccountRuntimeAuthAdapterV1['hotApply']>(async (input) => {
      expect(input).not.toHaveProperty('credential');
      expect(input).not.toHaveProperty('nativeHome');
      expect(input).not.toHaveProperty('runtimeControl');
      expect(input).not.toHaveProperty('validateCurrentBeforeMutation');
      const verification = await input.materializeNativeAuth?.();
      return {
        applied: verification?.status === 'verified',
        verification,
      };
    });
    const runtimeAuthAdapter: AgentConnectedAccountRuntimeAuthAdapterV1 = {
      classifyRuntimeAuthFailure: () => null,
      materializeActiveProfile: async () => ({ supported: true }),
      canHotApply: () => ({ supported: true }),
      hotApply,
      probeQuota: async () => ({ status: 'unsupported' }),
      refreshActiveProfile: async () => ({ status: 'unsupported' }),
    };
    const readFiles = vi.fn(async () => ({
      'auth.json': new TextEncoder().encode('{"old":true}'),
    }));
    const replaceFiles = vi.fn(async () => undefined);
    const validateCurrentBeforeMutation = vi.fn(async () => ({ current: true as const }));
    const projected = projectAgentConnectedAccountLaunchCatalogEntry({
      agentId: 'acme.external' as never,
      isCurrent: () => true,
      connectedAccountLaunch: {
        stateSharingDescriptor: {
          providerSupportStatus: 'supported',
          config: { supported: false, modes: [], entries: [] },
          state: {
            supported: false,
            modes: [],
            entries: [],
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
        },
        continuity: {
          nativeAuthCodec: { materialize, inspect },
          runtimeAuthAdapter,
        },
      },
    });
    const adapter = await projected.getConnectedServiceRuntimeAuthAdapter?.();
    const result = await adapter?.hotApply({
      target: { agentId: 'acme.external' },
      selection: {
        kind: 'group',
        serviceId: 'acme.plugin/acme-service',
        activeProfileId: 'profile-1',
        groupId: 'group-1',
        generation: 2,
        credentialRevision: 'revision-1',
      },
      credential: {
        v: 1,
        kind: 'oauth',
        serviceId: 'openai-codex',
        profileId: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
        oauth: {
          accessToken: 'secret-token',
          refreshToken: 'secret-refresh',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: 'account-1',
          providerEmail: null,
          raw: null,
        },
        token: null,
      },
      nativeHome: { readFiles, replaceFiles },
      validateCurrentBeforeMutation,
    });

    expect(result).toMatchObject({ applied: true });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(validateCurrentBeforeMutation).toHaveBeenCalledTimes(1);
    expect(validateCurrentBeforeMutation.mock.invocationCallOrder[0])
      .toBeLessThan(replaceFiles.mock.invocationCallOrder[0]!);
    expect(replaceFiles).toHaveBeenCalledWith({
      'auth.json': expect.any(Uint8Array),
    });
    expect(hotApply).toHaveBeenCalledTimes(1);
  });

  it('rejects Connected Account launch environment outside registration-owned host access', () => {
    expect(() => projectAgentConnectedAccountLaunchCatalogEntry({
      agentId: 'acme.external' as never,
      isCurrent: () => true,
      hostAccess: { required: [], optional: [] },
      connectedAccountLaunch: {
        environmentUses: [{
          purpose: 'model_upstream_api_key',
          environmentKey: 'ACME_API_KEY',
        }],
      },
    })).toThrow("Agent 'acme.external' connected-account launch environment 'ACME_API_KEY' is not declared");
  });

  it('runs a declared preflight command through host environment policy', async () => {
    const toolRoot = await mkdtemp(join(tmpdir(), 'happier-agent-preflight-'));
    const executable = writeExecutableShimSync({
      dir: toolRoot,
      fileName: process.platform === 'win32' ? 'external-agent.cmd' : 'external-agent',
      contents: process.platform === 'win32'
        ? ['@echo off', 'set ci=0', 'if defined CI set ci=1', 'set keep=0', 'if defined KEEP set keep=1', 'set drop=0', 'if defined DROP set drop=1', 'echo %ci%|%keep%|%drop%'].join('\r\n')
        : ['#!/bin/sh', 'ci=0; [ -n "${CI+x}" ] && ci=1', 'keep=0; [ -n "${KEEP+x}" ] && keep=1', 'drop=0; [ -n "${DROP+x}" ] && drop=1', 'printf "%s|%s|%s\\n" "$ci" "$keep" "$drop"'].join('\n'),
    });
    const preflightSessionControls = {
      models: {
        command: {
          toolId: 'external-agent-cli',
          args: ['models'],
          environmentExcludeKeys: ['DROP'],
          ci: 'omit',
        },
        parseOutput: ({ stdout }) => stdout.trim(),
      },
    } satisfies AgentPreflightSessionControlsContributionV1;
    const projected = projectAgentPreflightSessionControlsCatalogEntry({
      agentId: 'acme.external-agent' as never,
      preflightSessionControls,
      systemTools: [{
        id: 'external-agent-cli',
        title: 'External Agent CLI',
        executableNames: [executable],
      }],
      retirementSignal: new AbortController().signal,
      isCurrent: () => true,
    });

    try {
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      await expect(adapter?.probeModelsRaw?.({
        cwd: toolRoot,
        timeoutMs: 1_500,
        backendTarget: undefined,
        accountSettings: null,
        env: { CI: 'ambient', KEEP: 'kept', DROP: 'dropped' },
      })).resolves.toBe('0|1|0');
    } finally {
      await rm(toolRoot, { recursive: true, force: true });
    }
  });

  it('projects Agent CLI options through the host command owner', async () => {
    let current = true;
    const buildSessionOptions = vi.fn(() => ({
      ok: true as const,
      options: { externalAgentArgs: ['--fast'] },
    }));
    const declaration = {
      sessionRuntimeId: 'acme.external.backend',
      accountSettingsAgentId: 'acme.external',
      buildSessionOptions,
    } satisfies AgentCliSessionCommandDeclarationV1;
    const projected = projectAgentCliSessionCommandCatalogEntry({
      agentId: 'acme.external' as never,
      cliSessionCommand: declaration,
      isCurrent: () => current,
    });
    const handler = await projected.getCliCommandHandler?.();

    await handler?.({
      args: ['acme.external'],
      rawArgv: ['happier', 'acme.external'],
      terminalRuntime: null,
    });
    expect(runBackendSessionCliCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      backendIdForSessionRuntime: 'acme.external.backend',
      runtimeAuthorityAgentId: 'acme.external',
      agentIdForAccountSettings: 'acme.external',
      isExplicitCliSubcommand: true,
    }));
    const preferencesInput = {
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      environment: {},
      startOrigin: 'terminal' as const,
    };
    await expect(projected.resolveSessionRuntimePreferences?.(preferencesInput)).resolves.toEqual({
      externalAgentArgs: ['--fast'],
    });

    current = false;
    await handler?.({
      args: ['acme.external'],
      rawArgv: ['happier', 'acme.external'],
      terminalRuntime: null,
    });
    expect(runBackendSessionCliCommandMock).toHaveBeenCalledTimes(1);
    await expect(projected.resolveSessionRuntimePreferences?.(preferencesInput)).resolves.toEqual({});
    expect(buildSessionOptions).toHaveBeenCalledTimes(1);
  });

  it('injects only the owner-provided non-secret Settings projection for an Agent launch', async () => {
    const buildSessionOptions = vi.fn((input: AgentCliSessionCommandBuildInputV1) => ({
      ok: true as const,
      options: {
        accountSelected: input.pluginSettings.account?.ownedMode ?? null,
        daemonSelected: input.pluginSettings.daemon?.ownedMode ?? null,
      },
    }));
    const projected = projectAgentCliSessionCommandCatalogEntry({
      agentId: 'acme.external' as never,
      cliSessionCommand: {
        sessionRuntimeId: 'acme.external.backend',
        accountSettingsAgentId: 'acme.external',
        buildSessionOptions,
      },
      resolvePluginSettings: async () => ({
        account: { ownedMode: 'safe', secret: undefined },
        daemon: { ownedMode: 'daemon-safe' },
      }),
    });
    await expect(projected.resolveSessionRuntimePreferences?.({
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: { ownedMode: 'wrong-host-value' },
      environment: {},
      startOrigin: 'terminal',
    })).resolves.toEqual({ accountSelected: 'safe', daemonSelected: 'daemon-safe' });
    expect(buildSessionOptions).toHaveBeenCalledWith(expect.objectContaining({
      pluginSettings: {
        account: { ownedMode: 'safe', secret: undefined },
        daemon: { ownedMode: 'daemon-safe' },
      },
    }));
  });

  it('refuses a retained CLI handler when its generation retires during async delegation', async () => {
    let current = true;
    let settleDelegation!: (value: { kind: 'continue' }) => void;
    const runBackendSessionCliCommand = vi.fn(async () => undefined);
    const getHandler = createCliSessionCommandHandler(
      {
        sessionRuntimeId: 'acme.external',
        accountSettingsAgentId: 'acme.external',
        implicitResumeDelegation: { resumeFlags: ['--resume'] },
      },
      {
        cliSubcommand: 'acme.external',
        runtimeAuthorityAgentId: 'acme.external',
      },
      {
        runBackendSessionCliCommand,
        resolveSessionCommandResumeDelegation: async () => await new Promise((resolve) => {
          settleDelegation = resolve;
        }),
      },
      () => current,
    );
    const handler = await getHandler();
    const invocation = handler({
      args: ['--resume', 'session-1'],
      rawArgv: ['happier', '--resume', 'session-1'],
      terminalRuntime: null,
    });

    current = false;
    settleDelegation({ kind: 'continue' });
    await invocation;

    expect(runBackendSessionCliCommand).not.toHaveBeenCalled();
  });
});
