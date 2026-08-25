import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionTakeoverLaunchPlan,
  AgentExternalSessionTakeoverResolveLaunchRequest,
  AgentExternalSessionTakeoverResolveLaunchResult,
  AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
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

const PLUGIN_ID = 'happier.agent.fixture';
const AGENT_ID = 'fixture-agent';
const GENERATION = 'generation-7';
const TARGET_DIRECTORY = '/local/selected/workspace';

type HostPrivateTakeoverResolveLaunchResult =
  | AgentExternalSessionTakeoverResolveLaunchResult
  | Readonly<{
      ok: true;
      value: AgentExternalSessionTakeoverLaunchPlan;
      nativeResumeReference: string;
    }>;

type HostPrivateTakeoverResolveLaunch = (
  request: AgentExternalSessionTakeoverResolveLaunchRequest,
) => HostPrivateTakeoverResolveLaunchResult
  | Promise<HostPrivateTakeoverResolveLaunchResult>;

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
    codexBackendMode: null,
  };
}

function runtimeRegistry(params: Readonly<{
  externalSessions: AgentExternalSessionsContribution;
  takeover: AgentExternalSessionTakeoverContribution;
  hasPrimaryRuntime?: boolean;
  isCurrent?: () => boolean;
  generation?: string;
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
  const agentRuntimesByAgentId = new Map(createTargetAgentRuntimeRegistry({
    agents: [{
      id: AGENT_ID,
      pluginId: PLUGIN_ID,
    }],
    activationTargets: [target()],
    targetRegistrations: [{
      pluginId: PLUGIN_ID,
      generation: params.generation ?? GENERATION,
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
    isGenerationActive: params.isCurrent ?? (() => true),
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
}

function contributions(params: Readonly<{
  resolveLaunch?: HostPrivateTakeoverResolveLaunch;
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
      directory: '/fresh/workspace',
      backendModeHint: 'native-mode',
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
          backendTarget: {
            kind: 'backend',
            backendId: AGENT_ID,
            sourceKind: 'built_in',
          },
          existingSessionId: 'linked-session-1',
          resume: 'fresh-remote',
          approvedNewDirectoryCreation: true,
          backendMode: 'native-mode',
          environmentVariables: {
            FIXTURE_HOME: '/fresh/runtime',
          },
        },
        remoteSessionId: 'fresh-remote',
        origin: {
          agentId: AGENT_ID,
          pluginId: PLUGIN_ID,
          generation: GENERATION,
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

  it('uses an exact private native reference for the selected Pi file instead of an id-matched sibling', async () => {
    const selectedSessionFile = '/home/lee/.pi/agent/sessions/workspace-a/pi-shared.jsonl';
    const siblingSessionFile = '/home/lee/.pi/agent/sessions/workspace-b/pi-shared.jsonl';
    const fixture = contributions({
      resolveLaunch: async () => ({
        ok: true,
        value: {
          directory: '/fresh/workspace',
          environmentVariables: {
            FIXTURE_HOME: '/fresh/runtime',
          },
        },
        nativeResumeReference: selectedSessionFile,
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
          resume: selectedSessionFile,
          nativeResumeReference: selectedSessionFile,
        },
      },
    });
    if (!result.ok) return;
    expect(result.value.options.resume).not.toBe(siblingSessionFile);
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
          directory: privateDirectory,
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
        loadLocalHandoffMetadataByVendorResumeId: async () => null,
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
          directory: '/fresh/workspace',
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

    const projected = runtimeRegistry(fixture);
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
