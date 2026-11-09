import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionTakeoverLaunchPlan,
  AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  createPluginRuntimeOccurrenceId,
  type PluginRuntimeOccurrenceId,
} from '@/plugins/runtime/runtimeSlots';
import { prepareExecuteSpawnSessionRequest } from '@/daemon/startup/prepareExecuteSpawnSessionRequest';
import { logger } from '@/ui/logger';
import type { ActivationTarget } from '@/plugins/runtime/lifecycle/activation/targets';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import {
  createTargetAgentRuntimeRegistry,
  type AgentRuntimeRegistrationLease,
} from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';
import {
  resolveExternalTakeoverSpawnOptions,
  resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry,
  spawnResolvedExternalTakeoverSessionFromRuntimeRegistry,
} from './resolveExternalTakeoverSpawnOptions';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

type ResolveSessionDefaults = typeof import(
  '@/session/services/spawnConnectedServicesDefaults'
)['resolveSessionSpawnConnectedServicesDefaultsPayload'];

const outerResolutionMocks = vi.hoisted(() => ({
  acquireRuntimeRegistryLease: vi.fn(),
  readStoredCredentials: vi.fn(),
  resolveRuntimeSnapshot: vi.fn<typeof import('@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery')['resolveConnectedServiceRuntimeSnapshotForExternalSession']>(async () => ({})),
  resolveSessionDefaults: vi.fn<ResolveSessionDefaults>(async () => null),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease:
    outerResolutionMocks.acquireRuntimeRegistryLease,
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: outerResolutionMocks.readStoredCredentials,
}));
vi.mock('@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery', () => ({
  resolveConnectedServiceRuntimeSnapshotForExternalSession:
    outerResolutionMocks.resolveRuntimeSnapshot,
}));
vi.mock('@/session/services/spawnConnectedServicesDefaults', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/services/spawnConnectedServicesDefaults')>(),
  resolveSessionSpawnConnectedServicesDefaultsPayload:
    outerResolutionMocks.resolveSessionDefaults,
}));

const PLUGIN_ID = 'happier.agent.fixture';
const AGENT_ID = 'fixture-agent';
const GENERATION = 'generation-7';
const TARGET_DIRECTORY = '/local/selected/workspace';

function target(): ActivationTarget {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: PLUGIN_ID,
    manifestPath: `/plugins/${PLUGIN_ID}/plugin.json`,
    daemonEntryPath: `/plugins/${PLUGIN_ID}/daemon.js`,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${PLUGIN_ID}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: { version: '0.0.0' },
  } as unknown as ActivationTarget;
}

function linked(): LoadedLinkedExternalSession {
  return {
    rawSession: {
      id: 'linked-session-1',
      encryptionMode: 'plain',
    } as LoadedLinkedExternalSession['rawSession'],
    metadata: {},
    sessionPath: '/linked/workspace',
    agentId: AGENT_ID,
    machineId: 'machine-1',
    remoteSessionId: 'persisted-remote',
    linkGeneration: 'link-generation-1',
    source: {
      kind: 'fixtureSource',
      revision: 'persisted',
    },
    linkData: {
      revision: 'persisted',
    },
  };
}

function runtimeRegistry(params: Readonly<{
  externalSessions: AgentExternalSessionsContribution;
  takeover: AgentExternalSessionTakeoverContribution;
  hasPrimaryRuntime?: boolean;
  isCurrent?: () => boolean;
  generation?: string;
  occurrenceId?: PluginRuntimeOccurrenceId;
}>): ResolvedExecutablePluginRuntimeRegistry {
  const factory: AgentRuntimeFactory = async () => ({
    sessions: {
      open: async () => ({
        send: async () => ({ status: 'admitted' }),
        watch: () => ({ dispose() {} }),
        dispose() {},
      }),
    },
  });
  const occurrenceId = params.occurrenceId ?? createPluginRuntimeOccurrenceId(
    `${PLUGIN_ID}:${params.generation ?? GENERATION}`,
  );
  const agentRuntimesByAgentId = new Map(createTargetAgentRuntimeRegistry({
    agents: [{
      id: AGENT_ID,
      pluginId: PLUGIN_ID,
    }],
    activationTargets: [target()],
    targetRegistrations: [{
      pluginId: PLUGIN_ID,
      occurrenceId,
      registration: {
        family: 'agents',
        localId: AGENT_ID,
        value: {
          ...(params.hasPrimaryRuntime === false ? {} : { factory }),
          externalSessions: params.externalSessions,
          externalSessionTakeover: params.takeover,
        },
      } as ContributionRuntimeRegistration,
    }],
    readPluginOccurrenceId: (pluginId) => pluginId === PLUGIN_ID ? occurrenceId : null,
    readPluginSourceCustody: (pluginId) => pluginId === PLUGIN_ID
      ? { kind: 'development', registeredRootId: `/plugins/${PLUGIN_ID}` }
      : null,
    isOccurrenceCurrent: params.isCurrent ?? (() => true),
    retirementSignal: new AbortController().signal,
    onDuplicate: vi.fn(),
  }));
  const targetAgent = {
    id: AGENT_ID,
    identity: {
      pluginId: PLUGIN_ID,
      localId: AGENT_ID,
    },
    pluginId: PLUGIN_ID,
    provenance: 'first_party',
    source: { kind: 'bundled' },
    hostAccess: {
      required: [{
        id: 'fixture-process',
        capability: 'process',
        reason: 'Fixture process launch.',
        scope: {
          executables: [{ kind: 'systemTool', id: 'fixture-tool' }],
          envKeys: ['FIXTURE_HOME'],
        },
      }],
      optional: [],
    },
  };
  return {
    contributes: {
      agentDefinitionsById: new Map([[AGENT_ID, targetAgent]]),
    },
    agentRuntimesByAgentId,
    readPluginOccurrenceId: (pluginId: string) => pluginId === PLUGIN_ID ? occurrenceId : null,
    isPluginOccurrenceCurrent: (pluginId: string, candidate: PluginRuntimeOccurrenceId) => (
      pluginId === PLUGIN_ID && candidate === occurrenceId
    ),
    activateContributionsOnDemand: vi.fn(async () => []),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

function replaceRuntimeLease(
  targetRegistry: ResolvedExecutablePluginRuntimeRegistry,
  sourceRegistry: ResolvedExecutablePluginRuntimeRegistry,
): void {
  const replacement = sourceRegistry.agentRuntimesByAgentId.get(AGENT_ID);
  if (!replacement) {
    throw new Error('Expected a replacement Agent runtime lease');
  }
  (targetRegistry.agentRuntimesByAgentId as Map<
    string,
    AgentRuntimeRegistrationLease
  >).set(AGENT_ID, replacement);
  Object.assign(targetRegistry, {
    readPluginOccurrenceId: sourceRegistry.readPluginOccurrenceId,
    isPluginOccurrenceCurrent: sourceRegistry.isPluginOccurrenceCurrent,
  });
}

function contributions(params: Readonly<{
  resolveLaunch?: AgentExternalSessionTakeoverContribution['resolveLaunch'];
}> = {}): Readonly<{
  externalSessions: AgentExternalSessionsContribution;
  takeover: AgentExternalSessionTakeoverContribution;
  resolveLinkedIdentity: ReturnType<typeof vi.fn>;
  resolveLaunch: ReturnType<typeof vi.fn>;
}> {
  const resolveLinkedIdentity = vi.fn(async () => ({
    ok: true as const,
    value: {
      source: {
        kind: 'fixtureSource',
        revision: 'fresh',
      },
      remoteSessionId: 'fresh-remote',
      linkData: {
        revision: 'fresh',
      },
    },
  }));
  const resolveLaunch = vi.fn(params.resolveLaunch ?? (async () => ({
    ok: true as const,
    value: {
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: AGENT_ID,
        agent: { mode: 'native-mode' },
      },
      environmentVariables: {
        FIXTURE_HOME: '/fresh/runtime',
      },
    },
  })));
  const externalSessions: AgentExternalSessionsContribution = Object.freeze({
    resolveSource: async ({ source }) => ({
      ok: true as const,
      value: { source },
    }),
    listCandidates: async () => ({
      ok: true as const,
      value: { candidates: [], nextCursor: null },
    }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
      ok: true as const,
      value: { source, remoteSessionId, linkData: {} },
    }),
    resolveLinkedIdentity,
    pageTranscript: async () => ({
      ok: true as const,
      value: { items: [], nextCursor: null },
    }),
    readAfterTranscript: async () => ({
      ok: true as const,
      value: { outcome: 'already_current' as const },
    }),
  });
  return {
    externalSessions,
    takeover: Object.freeze({ resolveLaunch }),
    resolveLinkedIdentity,
    resolveLaunch,
  };
}

describe('External Session takeover launch consumption', () => {
  it('finishes launch resolution with admitted credentials after the ambient Home becomes unavailable', async () => {
    const fixture = contributions({
      resolveLaunch: async () => ({
        ok: true as const,
        value: { applyConnectedAccountDefaults: true },
      }),
    });
    outerResolutionMocks.acquireRuntimeRegistryLease.mockResolvedValueOnce({
      registry: runtimeRegistry(fixture),
      release: async () => undefined,
    });
    outerResolutionMocks.readStoredCredentials.mockRejectedValueOnce(new Error('Ambient Home changed'));
    const actualDefaults = await vi.importActual<typeof import('@/session/services/spawnConnectedServicesDefaults')>(
      '@/session/services/spawnConnectedServicesDefaults',
    );
    outerResolutionMocks.resolveSessionDefaults.mockImplementationOnce(
      actualDefaults.resolveSessionSpawnConnectedServicesDefaultsPayload,
    );
    const actualSnapshot = await vi.importActual<typeof import('@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery')>(
      '@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery',
    );
    outerResolutionMocks.resolveRuntimeSnapshot.mockImplementationOnce(
      actualSnapshot.resolveConnectedServiceRuntimeSnapshotForExternalSession,
    );
    try {
      await expect(resolveExternalTakeoverSpawnOptions({
        linked: linked(),
        sessionId: 'linked-session-1',
        targetDirectory: TARGET_DIRECTORY,
        credentials: { token: 'admitted-account-a', encryption: null },
      })).resolves.toMatchObject({ ok: true });
    } finally {
      outerResolutionMocks.readStoredCredentials.mockReset();
    }
  });

  it('applies the canonical account auth default when the Agent launch plan opts in', async () => {
    const fixture = contributions({
      resolveLaunch: async () => ({
        ok: true as const,
        value: {
          environmentVariables: { FIXTURE_HOME: '/fresh/runtime' },
          applyConnectedAccountDefaults: true,
        },
      }),
    });
    const registry = runtimeRegistry(fixture);
    outerResolutionMocks.acquireRuntimeRegistryLease.mockResolvedValueOnce({
      registry,
      release: vi.fn(async () => undefined),
    });
    const credentials = { token: 'token', encryption: null };
    outerResolutionMocks.readStoredCredentials.mockResolvedValueOnce(credentials);
    outerResolutionMocks.resolveRuntimeSnapshot.mockResolvedValueOnce({});
    outerResolutionMocks.resolveSessionDefaults.mockResolvedValueOnce({
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'fixture.plugin/service': {
            source: 'connected',
            selection: 'group',
            groupId: 'default-pool',
          },
        },
      },
      connectedServicesUpdatedAt: 1_718_719_700_000,
    });

    const result = await resolveExternalTakeoverSpawnOptions({
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
    });

    expect(outerResolutionMocks.resolveSessionDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID, credentials }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        options: {
          connectedServices: {
            v: 2,
            bindingsByServiceId: {
              'fixture.plugin/service': {
                source: 'connected',
                selection: 'group',
                groupId: 'default-pool',
              },
            },
          },
          connectedServicesUpdatedAt: 1_718_719_700_000,
        },
      },
    });
  });
  it.each(['direct', 'persisted'] as const)('preserves terminal preferences through the runtime registry and %s spawn', async (transcriptStorage) => {
    const fixture = contributions();
    const registry = runtimeRegistry(fixture);
    const terminal = { mode: 'tmux' as const, tmux: { sessionName: 'takeover', isolated: true, tmpDir: '/tmp/takeover-tmux' } };
    const result = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry,
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      transcriptStorage,
      terminal,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new Error(`Unexpected resolution failure: ${result.code}`);
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'linked-session-1' }));
    await expect(spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
      registry,
      resolved: result.value,
      options: { transcriptStorage },
      signal: new AbortController().signal,
      spawnSession,
    })).resolves.toEqual({ ok: true, value: { type: 'success', sessionId: 'linked-session-1' } });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ terminal, transcriptStorage }));
    expect(fixture.resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({ transcriptStorage }));
  });

  it('uses fresh identity from the same generation immediately before resolving the launch plan', async () => {
    const fixture = contributions();
    const registry = runtimeRegistry(fixture);

    const result = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry,
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        options: {
          directory: TARGET_DIRECTORY,
          agentTarget: {
            kind: 'agent',
            identity: {
              pluginId: PLUGIN_ID,
              localId: AGENT_ID,
            },
          },
          existingSessionId: 'linked-session-1',
          resume: 'fresh-remote',
          approvedNewDirectoryCreation: true,
          runtimeDescriptorV1: {
            v: 1,
            agentId: AGENT_ID,
            agent: { mode: 'native-mode' },
          },
          environmentVariables: {
            FIXTURE_HOME: '/fresh/runtime',
          },
        },
        remoteSessionId: 'fresh-remote',
        origin: {
          agentId: AGENT_ID,
          pluginId: PLUGIN_ID,
          occurrenceId: registry.readPluginOccurrenceId?.(PLUGIN_ID),
        },
      },
    });
    expect(fixture.resolveLinkedIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: 'fixtureSource',
          revision: 'persisted',
        },
        remoteSessionId: 'persisted-remote',
        linkData: {
          revision: 'persisted',
        },
      }),
    );
    expect(fixture.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedSessionId: 'linked-session-1',
        targetDirectory: TARGET_DIRECTORY,
        linkedDirectory: '/linked/workspace',
        source: {
          kind: 'fixtureSource',
          revision: 'fresh',
        },
        remoteSessionId: 'fresh-remote',
        linkData: {
          revision: 'fresh',
        },
      }),
    );
    expect(fixture.resolveLinkedIdentity.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.resolveLaunch.mock.invocationCallOrder[0] ?? 0);
  });

  it('carries an exact Agent-owned descriptor while generic resume keeps the linked id', async () => {
    const selectedSessionFile = '/home/lee/.pi/agent/sessions/workspace-a/pi-shared.jsonl';
    const siblingSessionFile = '/home/lee/.pi/agent/sessions/workspace-b/pi-shared.jsonl';
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: AGENT_ID,
      agent: {
        providerSessionId: 'pi-shared',
        sessionFile: selectedSessionFile,
      },
    };
    const fixture = contributions({
      resolveLaunch: async () => ({
        ok: true,
        value: {
          environmentVariables: {
            FIXTURE_HOME: '/fresh/runtime',
          },
          runtimeDescriptorV1,
        },
      }),
    });

    const result = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry: runtimeRegistry(fixture),
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        options: {
          resume: 'fresh-remote',
          runtimeDescriptorV1,
        },
      },
    });
    if (!result.ok) return;
    expect(result.value.options.runtimeDescriptorV1).not.toMatchObject({
      agent: { sessionFile: siblingSessionFile },
    });
  });

  it('keeps the resolved takeover plan private when it enters generic spawn preparation', async () => {
    const privateDirectory = '/Users/private-user/work/client-project';
    const privateMachineId = 'machine-private-identity';
    const privateProfileId = 'profile-private-identity';
    const privateEnvironmentValue = 'private-environment-value';
    const fixture = contributions({
      resolveLaunch: async () => ({
        ok: true,
        value: {
          environmentVariables: {
            FIXTURE_HOME: privateEnvironmentValue,
          },
        },
      }),
    });
    const resolved = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry: runtimeRegistry(fixture),
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: privateDirectory,
      signal: new AbortController().signal,
    });
    if (!resolved.ok) throw new Error(`Unexpected resolution failure: ${resolved.code}`);

    const result = await prepareExecuteSpawnSessionRequest({
      request: {
        options: {
          ...resolved.value.options,
          machineId: privateMachineId,
          profileId: privateProfileId,
        },
        credentials: { token: 'token', encryption: null },
      },
      validateEnvVarRecordStrict: () => ({
        ok: false,
        error: `Invalid environment variable FIXTURE_HOME=${privateEnvironmentValue}`,
      }),
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: 'INVALID_ENVIRONMENT_VARIABLES',
    });
    const persistentDiagnostics = JSON.stringify({
      debug: vi.mocked(logger.debug).mock.calls,
      debugLargeJson: vi.mocked(logger.debugLargeJson).mock.calls,
    });
    for (const privateFact of [
      privateDirectory,
      privateMachineId,
      privateProfileId,
      AGENT_ID,
      'FIXTURE_HOME',
      privateEnvironmentValue,
    ]) {
      expect(persistentDiagnostics).not.toContain(privateFact);
    }
  });

  it('maps a typed leaf refusal and rejects an invalid host launch plan without a spawn ticket', async () => {
    const unavailable = contributions({
      resolveLaunch: async () => ({
        ok: false,
        code: 'unavailable',
      }),
    });
    await expect(resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry: runtimeRegistry(unavailable),
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: false,
      code: 'unavailable',
    });

    const smuggling = contributions({
      resolveLaunch: async () => ({
        ok: true,
        value: {
          environmentVariables: {
            UNDECLARED_KEY: 'rejected',
          },
        },
      }),
    });
    await expect(resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry: runtimeRegistry(smuggling),
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('rechecks the originating generation and current primary runtime immediately before spawn', async () => {
    let current = true;
    const fixture = contributions();
    const registry = runtimeRegistry({
      ...fixture,
      isCurrent: () => current,
    });
    const resolved = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry,
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    });
    if (!resolved.ok) throw new Error(`Unexpected resolution failure: ${resolved.code}`);

    current = false;
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'linked-session-1',
    }));
    await expect(spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
      registry,
      resolved: resolved.value,
      options: {
        transcriptStorage: 'direct',
      },
      signal: new AbortController().signal,
      spawnSession,
    })).resolves.toEqual({
      ok: false,
      code: 'agent_unavailable',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects a replacement generation installed after launch resolution but before spawn', async () => {
    const original = contributions();
    const registry = runtimeRegistry(original);
    const resolved = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry,
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    });
    if (!resolved.ok) throw new Error(`Unexpected resolution failure: ${resolved.code}`);

    const replacement = runtimeRegistry({
      ...contributions(),
      generation: 'generation-8',
    });
    replaceRuntimeLease(registry, replacement);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'linked-session-1',
    }));

    await expect(spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
      registry,
      resolved: resolved.value,
      options: {
        transcriptStorage: 'direct',
      },
      signal: new AbortController().signal,
      spawnSession,
    })).resolves.toEqual({
      ok: false,
      code: 'agent_unavailable',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('admits an auxiliary takeover contribution only after the same generation gains a primary runtime', async () => {
    const fixture = contributions();
    const auxiliary = runtimeRegistry({
      ...fixture,
      hasPrimaryRuntime: false,
    });
    const resolved = await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
      registry: auxiliary,
      linked: linked(),
      sessionId: 'linked-session-1',
      targetDirectory: TARGET_DIRECTORY,
      signal: new AbortController().signal,
    });
    if (!resolved.ok) throw new Error(`Unexpected resolution failure: ${resolved.code}`);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'linked-session-1',
    }));

    await expect(spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
      registry: auxiliary,
      resolved: resolved.value,
      options: {
        transcriptStorage: 'persisted',
        persistedTakeoverAdmission: {
          mode: 'persisted',
          operationId: 'operation-1',
          attemptId: 'attempt-1',
        },
      },
      signal: new AbortController().signal,
      spawnSession,
    })).resolves.toEqual({
      ok: false,
      code: 'agent_unavailable',
    });
    expect(spawnSession).not.toHaveBeenCalled();

    const occurrenceId = auxiliary.readPluginOccurrenceId?.(PLUGIN_ID);
    if (!occurrenceId) throw new Error('Expected the auxiliary runtime occurrence');
    const projected = runtimeRegistry({ ...fixture, occurrenceId });
    replaceRuntimeLease(auxiliary, projected);
    await expect(spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
      registry: auxiliary,
      resolved: resolved.value,
      options: {
        transcriptStorage: 'persisted',
        persistedTakeoverAdmission: {
          mode: 'persisted',
          operationId: 'operation-1',
          attemptId: 'attempt-1',
        },
      },
      signal: new AbortController().signal,
      spawnSession,
    })).resolves.toEqual({
      ok: true,
      value: {
        type: 'success',
        sessionId: 'linked-session-1',
      },
    });
    expect(spawnSession).toHaveBeenCalledWith({
      ...resolved.value.options,
      transcriptStorage: 'persisted',
      persistedTakeoverAdmission: {
        mode: 'persisted',
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      },
    });
  });
});
