import { describe, expect, it, vi } from 'vitest';

import type {
  AgentCliAuthContributionV1,
  AgentConnectedAccountLaunchContributionV1,
  AgentCliSessionCommandDeclarationV1,
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentProviderCliAttachDeclarationV1,
  AgentRuntimeFactory,
  AgentSessionRunnerFactoryLocatorV1,
} from '../agentRuntime/index.js';
import { createPluginRegistrationScope } from './scope.js';

const factory: AgentRuntimeFactory = () => Object.freeze({
  sessions: Object.freeze({ open: vi.fn() }),
});

const locator = Object.freeze({
  module: './agent/runtime/factory.js',
  export: 'createAgentRuntime',
  runtimeApiVersion: 1,
}) satisfies AgentSessionRunnerFactoryLocatorV1;

const locatorWithExternalSessions = Object.freeze({
  ...locator,
  externalSessionsExport: 'externalSessions',
}) satisfies AgentSessionRunnerFactoryLocatorV1;

function scopeFor(
  requiredFields: readonly ('factory' | 'sessionRunnerFactory' | 'cliAuth')[],
) {
  return createPluginRegistrationScope({
    pluginId: 'example.agent',
    target: { realm: 'daemon' },
    rights: [{
      family: 'agents',
      localId: 'assistant',
      target: { realm: 'daemon' },
      requiredFields,
    }],
  });
}

describe('Agent runner-factory registration transaction', () => {
  it('retains a managed dependency ACP launch as an alternative to a system tool', () => {
    const scope = scopeFor(['factory']);
    const command = { executable: { kind: 'managedDependency' as const, id: 'native-acp' }, args: [] };
    scope.api.agents.register('assistant', factory, { preflightSessionControls: { catalogs: { kind: 'acp', command } } });
    const registered = scope.commit()[0]?.value as { preflightSessionControls?: { catalogs?: { command?: unknown } } };
    expect(registered.preflightSessionControls?.catalogs?.command).toEqual(command);
  });

  it('retains the provider-owned ACP authentication selector with its receiver', () => {
    const scope = scopeFor(['factory']);
    const catalogs = {
      kind: 'acp' as const,
      command: { toolId: 'assistant', args: ['acp'] },
      nativeMethodId: 'cached_token',
      selectAuthentication() { return { methodId: this.nativeMethodId, metadata: { headless: true } }; },
    };
    scope.api.agents.register('assistant', factory, { preflightSessionControls: { catalogs } });
    const registration = scope.commit()[0];
    const registered = registration?.value as {
      preflightSessionControls?: { catalogs?: { selectAuthentication?: () => unknown } };
    };
    expect(registered.preflightSessionControls?.catalogs?.selectAuthentication?.()).toEqual({ methodId: 'cached_token', metadata: { headless: true } });
  });

  it('retains the current native managed-service launch declaration with its catalog probe', () => {
    const scope = scopeFor(['factory']);
    const args = ['serve'];
    const contribution = {
      managedServiceCommands: [{ toolId: 'assistant-cli', args, environmentExcludeKeys: ['UNSELECTED_TOKEN'] }],
      probeCatalogs: () => ({ commands: null, skills: null }),
    };
    scope.api.agents.register('assistant', factory, { preflightSessionControls: contribution });
    const [registration] = scope.commit();
    args.push('--current-option');
    const registered = registration?.value as {
      preflightSessionControls?: { managedServiceCommands?: unknown };
    };
    expect(registered.preflightSessionControls?.managedServiceCommands).toEqual([
      { toolId: 'assistant-cli', args: ['serve', '--current-option'], environmentExcludeKeys: ['UNSELECTED_TOKEN'] },
    ]);
  });

  it('preserves native catalog discovery in the admitted Agent preflight contribution', async () => {
    const scope = scopeFor(['factory']);
    const contribution = {
      probeModels: () => null,
      probeCatalogs: async () => ({ commands: [{ name: 'review' }], skills: null }),
    };
    scope.api.agents.register('assistant', factory, { preflightSessionControls: contribution });
    const [registration] = scope.commit();
    const registered = registration?.value as {
      preflightSessionControls?: { probeCatalogs?: () => Promise<unknown> };
    };
    await expect(registered.preflightSessionControls?.probeCatalogs?.()).resolves.toEqual({
      commands: [{ name: 'review' }], skills: null,
    });
  });

  it('retains daemon spawn callbacks in the same Agent registration transaction', async () => {
    const scope = scopeFor(['factory']);
    const spawnSelection = Object.freeze({}) satisfies AgentDaemonSpawnRuntimeSelectionV1;
    const resolveRuntimePrerequisites = vi.fn(
      async (_selection: AgentDaemonSpawnRuntimeSelectionV1) => ({ ok: true as const }),
    );
    const augmentEnv = vi.fn(
      (_selection: AgentDaemonSpawnRuntimeSelectionV1) => ({ ACME_SPAWN_HOOK: 'enabled' }),
    );

    scope.api.agents.register('assistant', factory, {
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv,
      },
    });

    const [registration] = scope.commit();
    const daemonSpawnHooks = (registration?.value as {
      daemonSpawnHooks?: {
        resolveRuntimePrerequisites?: typeof resolveRuntimePrerequisites;
        augmentEnv?: typeof augmentEnv;
      };
    }).daemonSpawnHooks;

    expect(daemonSpawnHooks).toBeDefined();
    await expect(daemonSpawnHooks?.resolveRuntimePrerequisites?.(spawnSelection))
      .resolves.toEqual({ ok: true });
    expect(daemonSpawnHooks?.augmentEnv?.(spawnSelection)).toEqual({
      ACME_SPAWN_HOOK: 'enabled',
    });
  });

  it('retains the provider CLI attach declaration in the one Agent registration', () => {
    const scope = scopeFor(['factory']);
    const providerCliAttach = Object.freeze({
      commandToolIds: ['assistant', 'assistant-v2'],
      resolveCommandToolId: () => 'assistant-v2',
      managedServiceAccess: {
        credentialEnvironmentKey: 'ASSISTANT_SERVER_PASSWORD',
        credentialEnvironmentAliases: ['ASSISTANT_PASSWORD'],
        resolveTargetBaseUrl: () => 'http://127.0.0.1:4096',
      },
      resolveTarget: () => ({ ok: false as const, reason: 'fixture target is unavailable' }),
      createArgs: () => [],
      resolveReachability: () => null,
    }) satisfies AgentProviderCliAttachDeclarationV1;

    scope.api.agents.register('assistant', factory, {
      providerCliAttach,
    });

    const [registration] = scope.commit();
    const capturedProviderCliAttach = (registration?.value as {
      providerCliAttach?: AgentProviderCliAttachDeclarationV1;
    }).providerCliAttach;

    expect(capturedProviderCliAttach).toBeDefined();
    expect(capturedProviderCliAttach).toBe(providerCliAttach);
    expect(capturedProviderCliAttach?.commandToolIds).toEqual(['assistant', 'assistant-v2']);
    expect(capturedProviderCliAttach?.resolveCommandToolId?.({ accountSettings: null }))
      .toBe('assistant-v2');
    expect(capturedProviderCliAttach?.managedServiceAccess).toEqual({
      credentialEnvironmentKey: 'ASSISTANT_SERVER_PASSWORD',
      credentialEnvironmentAliases: ['ASSISTANT_PASSWORD'],
      resolveTargetBaseUrl: expect.any(Function),
    });
    expect(capturedProviderCliAttach?.managedServiceAccess?.credentialEnvironmentAliases)
      .toBe(providerCliAttach.managedServiceAccess.credentialEnvironmentAliases);
    expect(capturedProviderCliAttach?.resolveTarget({ metadata: {} })).toEqual({
      ok: false,
      reason: 'fixture target is unavailable',
    });
    expect(capturedProviderCliAttach?.createArgs({}, { cliVersion: null })).toEqual([]);
    expect(capturedProviderCliAttach?.resolveReachability({}, { cliVersion: null })).toBeNull();
  });

  it('retains the current Agent CLI session-command declaration in the one Agent registration', async () => {
    const scope = scopeFor(['factory']);
    const declaration = {
      sessionRuntimeId: 'assistant',
      directoryFlags: ['--directory'],
      buildSessionOptions: vi.fn(() => ({
        ok: true as const,
        options: { assistantArgs: ['--fast'] },
      })),
    } satisfies AgentCliSessionCommandDeclarationV1;

    scope.api.agents.register('assistant', factory, { cliSessionCommand: declaration });

    const [registration] = scope.commit();
    const capturedCliSessionCommand = (registration?.value as {
      cliSessionCommand?: AgentCliSessionCommandDeclarationV1;
    }).cliSessionCommand;
    declaration.directoryFlags.push('--later-mutation');

    expect(capturedCliSessionCommand).toBeDefined();
    expect(capturedCliSessionCommand).toBe(declaration);
    expect(capturedCliSessionCommand?.sessionRuntimeId).toBe('assistant');
    expect(capturedCliSessionCommand?.directoryFlags).toEqual(['--directory', '--later-mutation']);
    expect(await capturedCliSessionCommand?.buildSessionOptions?.({
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      pluginSettings: {},
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      ok: true,
      options: { assistantArgs: ['--fast'] },
    });
  });

  it('retains deferred-startup eligibility and experimental vendor-resume callbacks in the one Agent registration', () => {
    const scope = scopeFor(['factory']);
    const sessionStartup = {
      authorState: 'ignored',
      shouldUseDeferredBootstrap: vi.fn((input: Readonly<{
        startedBy: 'terminal' | 'daemon';
        hasPersistedPermissionModeSeed: boolean;
      }>) => input.startedBy === 'terminal' && input.hasPersistedPermissionModeSeed),
    };
    const vendorResumeSupport = {
      authorState: 'ignored',
      supportsVendorResume: vi.fn((input: Readonly<{
        agentRuntimeSelection?: Readonly<Record<string, unknown>>;
      }>) => input.agentRuntimeSelection?.mode === 'acp'),
    };

    scope.api.agents.register('assistant', factory, {
      sessionStartup,
      vendorResumeSupport,
    });

    const [registration] = scope.commit();
    const captured = registration?.value as {
      sessionStartup?: typeof sessionStartup;
      vendorResumeSupport?: typeof vendorResumeSupport;
    };

    expect(captured.sessionStartup).toBeDefined();
    expect(captured.sessionStartup).toBe(sessionStartup);
    expect(captured.sessionStartup?.shouldUseDeferredBootstrap({
      startedBy: 'terminal',
      hasPersistedPermissionModeSeed: true,
    })).toBe(true);

    expect(captured.vendorResumeSupport).toBeDefined();
    expect(captured.vendorResumeSupport).toBe(vendorResumeSupport);
    expect(captured.vendorResumeSupport?.supportsVendorResume({
      agentRuntimeSelection: { mode: 'acp' },
    })).toBe(true);
  });

  it('retains bounded external Agent continuity callbacks in that same registration', async () => {
    const scope = scopeFor(['factory']);
    const materialize = vi.fn(() => ({ files: {} }));
    const inspect = vi.fn(() => ({
      status: 'unavailable' as const,
      retryable: false,
      reason: 'missing_declared_file',
    }));
    const verifyResumeReachable = vi.fn(async (input: {
      vendorResumeId: string | null;
      sessionFiles: {
        findDeclaredCandidate(input: {
          matchesCandidate(candidate: { fileName: string; nativeSessionId: string | null }): boolean;
        }): Promise<{ found: boolean }>;
      };
    }) => {
      const candidate = await input.sessionFiles.findDeclaredCandidate({
        matchesCandidate: ({ nativeSessionId }) => nativeSessionId === input.vendorResumeId,
      });
      return candidate.found ? { ok: true as const } : { ok: false as const, reason: 'not_found' };
    });
    scope.api.agents.register('assistant', factory, {
      connectedAccountLaunch: {
        stateSharingDescriptor: {
          providerSupportStatus: 'supported',
          config: { supported: false, modes: ['isolated'], entries: [] },
          state: {
            supported: true,
            modes: ['shared'],
            entries: [{ path: 'sessions', mode: 'linked' }],
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'process_env', secretEntries: [] },
        },
        continuity: {
          nativeAuthCodec: { materialize, inspect },
          verifyResumeReachable,
        },
      },
    });

    const [registration] = scope.commit();
    const captured = (registration?.value as {
      connectedAccountLaunch?: {
        continuity?: {
          nativeAuthCodec?: { materialize: typeof materialize; inspect: typeof inspect };
          verifyResumeReachable?: typeof verifyResumeReachable;
        };
      };
    }).connectedAccountLaunch?.continuity;

    expect(captured?.nativeAuthCodec?.materialize).toBe(materialize);
    expect(captured?.nativeAuthCodec?.inspect).toBe(inspect);
    const findDeclaredCandidate = vi.fn(async (input: {
      matchesCandidate(candidate: { fileName: string; nativeSessionId: string | null }): boolean;
    }) => ({
      found: input.matchesCandidate({ fileName: 'session-native-id.jsonl', nativeSessionId: 'native-id' }),
    }));
    await expect(captured?.verifyResumeReachable?.({
      vendorResumeId: 'native-id',
      sessionFiles: { findDeclaredCandidate },
    })).resolves.toEqual({ ok: true });
    expect(findDeclaredCandidate).toHaveBeenCalledTimes(1);
    expect(verifyResumeReachable).toHaveBeenCalledTimes(1);
  });

  it('captures a focused Agent CLI auth contribution in the one Agent registration', async () => {
    const scope = scopeFor(['factory', 'cliAuth']);
    const cliAuth = {
      detectAuthStatus: vi.fn(async () => ({
        state: 'logged_in' as const,
        method: 'oauth_cli' as const,
        source: 'command' as const,
      })),
    } satisfies AgentCliAuthContributionV1;

    scope.api.agents.register('assistant', factory, { cliAuth });

    const [registration] = scope.commit();
    const capturedCliAuth = (registration?.value as {
      cliAuth?: AgentCliAuthContributionV1;
    }).cliAuth;

    expect(capturedCliAuth).toBeDefined();
    expect(capturedCliAuth).toBe(cliAuth);
    await expect(capturedCliAuth?.detectAuthStatus({
      runDeclaredSystemToolCommand: vi.fn(async () => ({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
      })),
    })).resolves.toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
  });

  it('captures focused terminal prompt recognition in the one Agent registration', () => {
    const scope = scopeFor(['factory']);
    const terminalPromptSubmitVerification = {
      authorState: 'ignored',
      shouldVerifyAfterSubmit: vi.fn((promptText: string) => promptText.trim().length > 0),
      verifyBeforeSubmitStaging: vi.fn((input: Readonly<{ promptText: string; screenText: string }>) => (
        input.screenText.includes(input.promptText)
      )),
      verifyAfterSubmit: vi.fn((input: Readonly<{ promptText: string; screenText: string }>) => (
        input.screenText.includes(input.promptText)
      )),
    };

    scope.api.agents.register('assistant', factory, { terminalPromptSubmitVerification });

    const [registration] = scope.commit();
    const captured = (registration?.value as {
      terminalPromptSubmitVerification?: typeof terminalPromptSubmitVerification;
    }).terminalPromptSubmitVerification;

    expect(captured).toBeDefined();
    expect(captured).toBe(terminalPromptSubmitVerification);
    expect(captured?.shouldVerifyAfterSubmit('continue')).toBe(true);
    expect(captured?.verifyBeforeSubmitStaging?.({ promptText: 'continue', screenText: 'continue' })).toBe(true);
    expect(captured?.verifyAfterSubmit({ promptText: 'continue', screenText: 'continue' })).toBe(true);
  });

  it('retains prepared command descriptors through Agent registration', () => {
    const scope = scopeFor(['factory']);
    const prepareCommand = () => ({ args: [{ kind: 'temporaryTextFile' as const, suffix: '.mjs', contents: 'export default {};' }] });
    scope.api.agents.register('assistant', factory, {
      preflightSessionControls: { models: { command: { toolId: 'assistant', args: ['models'], prepareCommand } } },
    });
    const registered = scope.commit()[0]?.value as { preflightSessionControls: { models: { command: { prepareCommand?: typeof prepareCommand } } } };
    expect(registered.preflightSessionControls.models.command.prepareCommand?.()).toEqual({
      args: [{ kind: 'temporaryTextFile', suffix: '.mjs', contents: 'export default {};' }],
    });
  });

  it('captures connected-account launch facts without replacing a host-owned ACP runtime', () => {
    const scope = scopeFor([]);
    const contribution = {
      switchContinuity: {
        continuityMode: 'restart_shared_state_required',
        supportedTransitions: ['same_connected_group'],
      },
      continuity: { generationApplicationScope: 'per_session_runtime' },
    } satisfies AgentConnectedAccountLaunchContributionV1;
    scope.api.agents.registerConnectedAccountLaunch('assistant', contribution);
    const [registration] = scope.commit();
    expect(registration?.value).toMatchObject({ connectedAccountLaunch: contribution });
    expect(registration?.value).not.toHaveProperty('factory');
  });

  it('captures an auth-only auxiliary registration for a declarative ACP Agent', () => {
    const scope = createPluginRegistrationScope({
      pluginId: 'example.declarative-acp-agent',
      target: { realm: 'daemon' },
      rights: [{
        family: 'agents',
        localId: 'acp-agent',
        target: { realm: 'daemon' },
        requiredFields: ['cliAuth'],
      }],
    });
    const cliAuth = {
      detectAuthStatus: vi.fn(async () => ({
        state: 'logged_in' as const,
        method: 'oauth_cli' as const,
        source: 'command' as const,
      })),
    } satisfies AgentCliAuthContributionV1;
    scope.api.agents.registerCliAuth('acp-agent', cliAuth);

    const [registration] = scope.commit();
    expect((registration?.value as { cliAuth?: AgentCliAuthContributionV1 }).cliAuth).toBe(cliAuth);
    expect((registration?.value as { factory?: unknown }).factory).toBeUndefined();
  });

  it('refuses an entirely missing manifest-declared Agent registration', () => {
    const scope = createPluginRegistrationScope({
      pluginId: 'example.declarative-acp-agent',
      target: { realm: 'daemon' },
      rights: [{
        family: 'agents',
        localId: 'acp-agent',
        target: { realm: 'daemon' },
        requiredFields: ['cliAuth'],
      }],
    });

    expect(() => scope.commit()).toThrow(
      /activation is missing registration 'agents\/acp-agent'/i,
    );
  });

  it('commits a trusted factory without policing legacy required-field metadata', () => {
    const scope = scopeFor(['factory', 'cliAuth']);
    scope.api.agents.register('assistant', factory);

    expect(scope.commit()).toEqual([{
      family: 'agents',
      localId: 'assistant',
      value: { factory },
    }]);
  });

  it('commits one session-capable factory with its runner locator', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);

    scope.api.agents.register('assistant', factory, { sessionRunnerFactory: locator });

    expect(scope.commit()).toEqual([{
      family: 'agents',
      localId: 'assistant',
      value: { factory, sessionRunnerFactory: locator },
    }]);
  });

  it('retains an optional External Sessions export on the factory module', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);

    scope.api.agents.register('assistant', factory, {
      sessionRunnerFactory: locatorWithExternalSessions,
    });

    expect(scope.commit()).toEqual([{
      family: 'agents',
      localId: 'assistant',
      value: { factory, sessionRunnerFactory: locatorWithExternalSessions },
    }]);
  });

  it('retains the trusted runner locator reference and its current fields', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);
    const mutableLocator = {
      module: './agent/runtime/factory.js',
      export: 'createAgentRuntime',
      runtimeApiVersion: 1 as const,
      externalSessionsExport: 'externalSessions',
    };

    scope.api.agents.register('assistant', factory, {
      sessionRunnerFactory: mutableLocator,
    });
    mutableLocator.externalSessionsExport = 'replacementExternalSessions';

    const [registration] = scope.commit();
    expect(registration?.value).toMatchObject({
      sessionRunnerFactory: {
        externalSessionsExport: 'replacementExternalSessions',
      },
    });
    expect((registration?.value as { sessionRunnerFactory?: AgentSessionRunnerFactoryLocatorV1 }).sessionRunnerFactory)
      .toBe(mutableLocator);
    mutableLocator.externalSessionsExport = 'laterExternalSessions';
    expect(registration?.value).toMatchObject({
      sessionRunnerFactory: {
        externalSessionsExport: 'laterExternalSessions',
      },
    });
  });

  it('does not manufacture Agent registration rights for a Provider-only package', () => {
    const scope = createPluginRegistrationScope({
      pluginId: 'example.provider',
      target: { realm: 'daemon' },
      rights: [],
    });

    expect(() => scope.api.agents.register(
      'provider-only',
      factory,
      { sessionRunnerFactory: locator },
    )).toThrow(/undeclared contribution/i);
    expect(scope.registrations()).toEqual([]);
  });
});
