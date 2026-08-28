import { describe, expect, it, vi } from 'vitest';

import type {
  AgentCliAuthContributionV1,
  AgentCliSessionCommandDeclarationV1,
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentProviderCliAttachDeclarationV1,
  AgentRuntimeFactory,
  AgentSessionRunnerFactoryLocatorV1,
} from '../../agentRuntime/index.js';
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
  it('captures bounded daemon spawn hooks in the same Agent registration transaction', async () => {
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
    expect(Object.isFrozen(daemonSpawnHooks)).toBe(true);
    await expect(daemonSpawnHooks?.resolveRuntimePrerequisites?.(spawnSelection))
      .resolves.toEqual({ ok: true });
    expect(daemonSpawnHooks?.augmentEnv?.(spawnSelection)).toEqual({
      ACME_SPAWN_HOOK: 'enabled',
    });
  });

  it('captures the focused provider CLI attach declaration in the one Agent registration', () => {
    const scope = scopeFor(['factory']);
    const providerCliAttach = Object.freeze({
      resolveTarget: () => ({ ok: false as const, reason: 'fixture target is unavailable' }),
      createArgs: () => [],
      buildHealthUrl: () => null,
    }) satisfies AgentProviderCliAttachDeclarationV1;

    scope.api.agents.register('assistant', factory, {
      providerCliAttach,
    });

    const [registration] = scope.commit();
    const capturedProviderCliAttach = (registration?.value as {
      providerCliAttach?: AgentProviderCliAttachDeclarationV1;
    }).providerCliAttach;

    expect(capturedProviderCliAttach).toBeDefined();
    expect(capturedProviderCliAttach).not.toBe(providerCliAttach);
    expect(Object.isFrozen(capturedProviderCliAttach)).toBe(true);
    expect(capturedProviderCliAttach?.resolveTarget({ metadata: {} })).toEqual({
      ok: false,
      reason: 'fixture target is unavailable',
    });
    expect(capturedProviderCliAttach?.createArgs({})).toEqual([]);
    expect(capturedProviderCliAttach?.buildHealthUrl({})).toBeNull();
  });

  it('captures a focused Agent CLI session-command declaration in the one Agent registration', () => {
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
    expect(capturedCliSessionCommand).not.toBe(declaration);
    expect(Object.isFrozen(capturedCliSessionCommand)).toBe(true);
    expect(capturedCliSessionCommand?.sessionRuntimeId).toBe('assistant');
    expect(capturedCliSessionCommand?.directoryFlags).toEqual(['--directory']);
    expect(capturedCliSessionCommand?.buildSessionOptions?.({
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      environment: {},
      startOrigin: 'terminal',
    })).toEqual({
      ok: true,
      options: { assistantArgs: ['--fast'] },
    });
  });

  it('captures deferred-startup eligibility and experimental vendor-resume policy in the one Agent registration', () => {
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
    expect(captured.sessionStartup).not.toBe(sessionStartup);
    expect(Object.isFrozen(captured.sessionStartup)).toBe(true);
    expect(captured.sessionStartup?.shouldUseDeferredBootstrap({
      startedBy: 'terminal',
      hasPersistedPermissionModeSeed: true,
    })).toBe(true);

    expect(captured.vendorResumeSupport).toBeDefined();
    expect(captured.vendorResumeSupport).not.toBe(vendorResumeSupport);
    expect(Object.isFrozen(captured.vendorResumeSupport)).toBe(true);
    expect(captured.vendorResumeSupport?.supportsVendorResume({
      agentRuntimeSelection: { mode: 'acp' },
    })).toBe(true);
  });

  it('captures strict connected-account launch facts in the one Agent registration', () => {
    const scope = scopeFor(['factory']);
    const connectedAccountLaunch = {
      requestAuthUses: [{
        purpose: 'model_upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
      fileEnvironmentUses: [{
        purpose: 'agent_config',
        fileId: 'credentials',
        environmentKey: 'EXAMPLE_AGENT_CREDENTIALS',
      }],
      environmentUses: [{
        purpose: 'agent_token',
        environmentKey: 'EXAMPLE_AGENT_TOKEN',
      }],
      switchContinuity: {
        continuityMode: 'restart_same_home' as const,
        supportedTransitions: ['native_to_connected'],
      },
      stateSharingDescriptor: {
        nativeHome: {
          environmentKey: 'EXAMPLE_AGENT_HOME',
          defaultRelativePath: '.example-agent',
        },
        providerSupportStatus: 'supported',
        config: {
          supported: true,
          modes: ['linked', 'copied', 'isolated'],
          entries: [{ path: 'config.toml', mode: 'linked_or_copied' }],
        },
        state: {
          supported: true,
          modes: ['isolated', 'shared'],
          entries: [{ path: 'sessions', mode: 'linked' }],
          symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
        },
        authIsolation: {
          mode: 'materialized_home',
          secretEntries: ['auth.json'],
        },
      },
    };

    scope.api.agents.register('assistant', factory, {
      ...({ connectedAccountLaunch } as unknown as object),
    });

    const [registration] = scope.commit();
    const captured = (registration?.value as {
      connectedAccountLaunch?: typeof connectedAccountLaunch;
    }).connectedAccountLaunch;
    connectedAccountLaunch.requestAuthUses[0]!.purpose = 'mutated';
    connectedAccountLaunch.fileEnvironmentUses[0]!.fileId = 'mutated';
    connectedAccountLaunch.environmentUses[0]!.purpose = 'mutated';
    connectedAccountLaunch.switchContinuity.supportedTransitions[0] = 'connected_to_native';
    connectedAccountLaunch.stateSharingDescriptor.config.entries[0]!.path = 'mutated.toml';
    connectedAccountLaunch.stateSharingDescriptor.nativeHome.defaultRelativePath = '../escape';

    expect(captured).toEqual({
      requestAuthUses: [{
        purpose: 'model_upstream',
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://api.example.test',
          headerNames: ['authorization'],
        },
      }],
      fileEnvironmentUses: [{
        purpose: 'agent_config',
        fileId: 'credentials',
        environmentKey: 'EXAMPLE_AGENT_CREDENTIALS',
      }],
      environmentUses: [{
        purpose: 'agent_token',
        environmentKey: 'EXAMPLE_AGENT_TOKEN',
      }],
      switchContinuity: {
        continuityMode: 'restart_same_home',
        supportedTransitions: ['native_to_connected'],
      },
      stateSharingDescriptor: {
        nativeHome: {
          environmentKey: 'EXAMPLE_AGENT_HOME',
          defaultRelativePath: '.example-agent',
        },
        providerSupportStatus: 'supported',
        config: {
          supported: true,
          modes: ['linked', 'copied', 'isolated'],
          entries: [{ path: 'config.toml', mode: 'linked_or_copied' }],
        },
        state: {
          supported: true,
          modes: ['isolated', 'shared'],
          entries: [{ path: 'sessions', mode: 'linked' }],
          symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
        },
        authIsolation: {
          mode: 'materialized_home',
          secretEntries: ['auth.json'],
        },
      },
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.requestAuthUses)).toBe(true);
    expect(Object.isFrozen(captured?.fileEnvironmentUses)).toBe(true);
    expect(Object.isFrozen(captured?.environmentUses)).toBe(true);
    expect(Object.isFrozen(captured?.switchContinuity)).toBe(true);
    expect(Object.isFrozen(captured?.stateSharingDescriptor)).toBe(true);
    expect(Object.isFrozen(captured?.stateSharingDescriptor?.nativeHome)).toBe(true);
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

    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.nativeAuthCodec)).toBe(true);
    expect(captured?.nativeAuthCodec?.materialize).not.toBe(materialize);
    expect(captured?.nativeAuthCodec?.inspect).not.toBe(inspect);
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

  it('rejects resume reachability without a host-owned state-sharing descriptor', () => {
    const scope = scopeFor(['factory']);
    scope.api.agents.register('assistant', factory, {
      connectedAccountLaunch: {
        continuity: {
          verifyResumeReachable: async () => ({ ok: false, reason: 'not_found' }),
        },
      },
    });

    expect(() => scope.commit()).toThrow(
      'Agent connected-account launch continuity.verifyResumeReachable requires a supported stateSharingDescriptor with declared state entries',
    );
  });

  it('rejects resume reachability backed by an unsupported empty state declaration', () => {
    const scope = scopeFor(['factory']);
    scope.api.agents.register('assistant', factory, {
      connectedAccountLaunch: {
        stateSharingDescriptor: {
          providerSupportStatus: 'unsupported',
          config: { supported: false, modes: ['isolated'], entries: [] },
          state: {
            supported: false,
            modes: ['isolated'],
            entries: [],
            symlinkUnavailableDegradePolicy: 'block_continuity',
          },
          authIsolation: { mode: 'process_env', secretEntries: [] },
        },
        continuity: {
          verifyResumeReachable: async () => ({ ok: false, reason: 'not_found' }),
        },
      },
    });
    expect(() => scope.commit()).toThrow(
      'Agent connected-account launch continuity.verifyResumeReachable requires a supported stateSharingDescriptor with declared state entries',
    );
  });

  it.each([
    { environmentKey: 'NOT-AN-ENV', defaultRelativePath: '.agent' },
    { environmentKey: 'AGENT_HOME', defaultRelativePath: '/tmp/agent' },
    { environmentKey: 'AGENT_HOME', defaultRelativePath: '../agent' },
    { environmentKey: 'AGENT_HOME', defaultRelativePath: 'agent\\home' },
  ])('rejects an unsafe connected-account native home %s', (nativeHome) => {
    const scope = scopeFor(['factory']);
    expect(() => {
      scope.api.agents.register('assistant', factory, {
        connectedAccountLaunch: {
          stateSharingDescriptor: {
            nativeHome,
            providerSupportStatus: 'unsupported',
            config: { supported: false, modes: ['isolated'], entries: [] },
            state: {
              supported: false,
              modes: ['isolated'],
              entries: [],
              symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
            },
            authIsolation: { mode: 'process_env', secretEntries: [] },
          },
        },
      } as never);
      scope.commit();
    }).toThrow("Plugin 'example.agent' registered an invalid 'agents/assistant' runtime");
  });

  it.each([
    { fileEnvironmentUses: [] },
    { fileEnvironmentUses: [{ purpose: 'config', fileId: '', environmentKey: 'AGENT_CONFIG' }] },
    { environmentUses: [{ purpose: 'token', environmentKey: 'NOT-AN-ENV' }] },
  ])('rejects invalid connected-account environment launch uses %s', (connectedAccountLaunch) => {
    const scope = scopeFor(['factory']);
    expect(() => {
      scope.api.agents.register('assistant', factory, { connectedAccountLaunch } as never);
      scope.commit();
    }).toThrow("Plugin 'example.agent' registered an invalid 'agents/assistant' runtime");
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
    expect(capturedCliAuth).not.toBe(cliAuth);
    expect(Object.isFrozen(capturedCliAuth)).toBe(true);
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
    expect(captured).not.toBe(terminalPromptSubmitVerification);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured?.shouldVerifyAfterSubmit('continue')).toBe(true);
    expect(captured?.verifyBeforeSubmitStaging?.({ promptText: 'continue', screenText: 'continue' })).toBe(true);
    expect(captured?.verifyAfterSubmit({ promptText: 'continue', screenText: 'continue' })).toBe(true);
  });

  it('projects only declared preflight fields from trusted structural author objects', () => {
    const scope = scopeFor(['factory']);
    scope.api.agents.register('assistant', factory, {
      preflightSessionControls: {
        authorState: 'ignored',
        models: {
          authorState: 'ignored',
          command: {
            authorState: 'ignored',
            toolId: 'assistant',
            args: ['models'],
          },
          fallback: {
            authorState: 'ignored',
            command: {
              authorState: 'ignored',
              toolId: 'assistant',
              args: ['models', '--fallback'],
            },
          },
        },
      },
    } as never);

    expect(() => scope.commit()).not.toThrow();
    expect((scope.registrations()[0]?.value as {
      preflightSessionControls?: unknown;
    }).preflightSessionControls).toEqual({
      models: {
        command: { toolId: 'assistant', args: ['models'] },
        fallback: {
          command: { toolId: 'assistant', args: ['models', '--fallback'] },
        },
      },
    });
  });

  it('captures an auth-only auxiliary registration for a declarative ACP Agent', async () => {
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
    const agents = scope.api.agents as typeof scope.api.agents & Readonly<{
      registerCliAuth?: (id: string, contribution: AgentCliAuthContributionV1) => void;
    }>;

    expect(agents.registerCliAuth).toBeTypeOf('function');
    agents.registerCliAuth?.('acp-agent', cliAuth);

    const [registration] = scope.commit();
    expect(registration?.value).toMatchObject({ cliAuth: expect.any(Object) });
    expect((registration?.value as { factory?: unknown }).factory).toBeUndefined();
  });

  it('refuses a declarative ACP Agent that declares a CLI auth probe but does not register it', () => {
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

  it('refuses a partial Agent registration that omits its declared CLI auth contribution', () => {
    const scope = scopeFor(['factory', 'cliAuth']);
    scope.api.agents.register('assistant', factory);

    expect(() => scope.commit()).toThrow(
      /activation is missing Agent CLI auth contribution for 'agents\/assistant'/i,
    );
  });

  it('rejects an empty daemon spawn hook bag before it can become an open callback registry', () => {
    const scope = scopeFor(['factory']);

    scope.api.agents.register('assistant', factory, { daemonSpawnHooks: {} });

    expect(() => scope.commit()).toThrow(/invalid 'agents\/assistant' runtime/i);
    expect(scope.registrations()).toEqual([]);
  });

  it('commits one session-capable factory with its immutable runner locator', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);

    scope.api.agents.register('assistant', factory, { sessionRunnerFactory: locator });

    expect(scope.commit()).toEqual([{
      family: 'agents',
      localId: 'assistant',
      value: { factory, sessionRunnerFactory: locator },
    }]);
  });

  it('accepts an optional External Sessions export on the authenticated factory module', () => {
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

  it.each([
    ['not-an-export'],
    ['9externalSessions'],
    ['external.sessions'],
  ])('rejects invalid External Sessions export name %s', (externalSessionsExport) => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);

    scope.api.agents.register('assistant', factory, {
      sessionRunnerFactory: {
        ...locator,
        externalSessionsExport,
      },
    });
    expect(() => scope.commit()).toThrow(/invalid 'agents\/assistant' runtime/i);
    expect(scope.registrations()).toEqual([]);
  });

  it('ignores unrelated locator fields when the optional External Sessions export is present', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);

    scope.api.agents.register('assistant', factory, {
      sessionRunnerFactory: {
        ...locatorWithExternalSessions,
        externalSessionsModule: './agent/runtime/externalSessions.js',
      } as AgentSessionRunnerFactoryLocatorV1,
    });
    expect(() => scope.commit()).not.toThrow();
    expect(scope.registrations()).toEqual([{
      family: 'agents',
      localId: 'assistant',
      value: { factory, sessionRunnerFactory: locatorWithExternalSessions },
    }]);
  });

  it('captures the current locator at commit and isolates later mutation', () => {
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
    mutableLocator.externalSessionsExport = 'laterExternalSessions';
    expect(registration?.value).toMatchObject({
      sessionRunnerFactory: {
        externalSessionsExport: 'replacementExternalSessions',
      },
    });
    expect(Object.isFrozen(
      (registration?.value as { sessionRunnerFactory?: unknown }).sessionRunnerFactory,
    )).toBe(true);
  });

  it('rejects a missing locator for a session-capable custom Agent before publication', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);
    scope.api.agents.register('assistant', factory);

    expect(() => scope.commit()).toThrow(/missing Agent session runner factory locator/i);
    expect(scope.registrations()).toEqual([]);
  });

  it('rejects a locator for an execution-only Agent before publication', () => {
    const scope = scopeFor(['factory']);

    scope.api.agents.register(
      'assistant',
      factory,
      { sessionRunnerFactory: locator },
    );
    expect(() => scope.commit()).toThrow(/cannot register a Session runner factory locator/i);
    expect(scope.registrations()).toEqual([]);
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
