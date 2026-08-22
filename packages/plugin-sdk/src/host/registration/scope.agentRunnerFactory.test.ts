import { describe, expect, it, vi } from 'vitest';

import type {
  AgentDaemonSpawnRuntimeSelectionV1,
  AgentRuntimeFactory,
  AgentSessionRunnerFactoryLocatorV1,
} from '../../agentRuntime/index.js';
import { createPluginRegistrationScope } from './scope.js';

const factory: AgentRuntimeFactory = () => Object.freeze({
  sessions: Object.freeze({ open: vi.fn() }),
  executionRuns: Object.freeze({ open: vi.fn() }),
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
  requiredFields: readonly ('factory' | 'sessionRunnerFactory')[],
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

  it('rejects an empty daemon spawn hook bag before it can become an open callback registry', () => {
    const scope = scopeFor(['factory']);

    scope.api.agents.register('assistant', factory, { daemonSpawnHooks: {} });

    expect(() => scope.commit()).toThrow(/invalid 'agents\/assistant' runtime/i);
    expect(scope.registrations()).toEqual([]);
  });

  it('commits one session-capable composite factory with its immutable runner locator', () => {
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

  it('rejects unknown locator fields when the optional External Sessions export is present', () => {
    const scope = scopeFor(['factory', 'sessionRunnerFactory']);

    scope.api.agents.register('assistant', factory, {
      sessionRunnerFactory: {
        ...locatorWithExternalSessions,
        externalSessionsModule: './agent/runtime/externalSessions.js',
      } as AgentSessionRunnerFactoryLocatorV1,
    });
    expect(() => scope.commit()).toThrow(/invalid 'agents\/assistant' runtime/i);
    expect(scope.registrations()).toEqual([]);
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
