import { describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

function createRegistration(eventId: 'agent.resolvePrerequisites' | 'agent.spawnEnv.augment'): ResolvedActivatedHookRegistration {
  const prerequisite = eventId === 'agent.resolvePrerequisites';
  return {
    provenance: 'first_party',
    source: { kind: 'bundled' },
    pluginId: 'happier.agent.codex',
    manifestPath: '/plugins/codex/plugin.json',
    daemonEntryPath: '/plugins/codex/daemon.mjs',
    sourceSpec: {
      kind: 'bundled',
      locator: '@happier-dev/plugins-codex',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    definition: {
      hookApiVersion: 1,
      id: eventId,
      category: prerequisite ? 'decision' : 'augmentation',
      scope: prerequisite ? 'agent' : 'daemon',
      executionKind: prerequisite ? 'decide' : 'augment',
      filters: { agentId: 'codex' },
    },
  };
}

function createRuntimeRegistry(params: Readonly<{
  events: string[];
  prerequisiteEnvironments: unknown[];
}>): ResolvedExecutablePluginRuntimeRegistry {
  const createHandler = (eventId: 'agent.resolvePrerequisites' | 'agent.spawnEnv.augment') => {
    const registration = createRegistration(eventId);
    return {
      pluginId: 'happier.agent.codex',
      localId: eventId,
      hookId: eventId,
      priority: 0,
      registrationIndex: eventId === 'agent.resolvePrerequisites' ? 0 : 1,
      manifestPath: registration.manifestPath,
      daemonEntryPath: registration.daemonEntryPath,
      registration,
      handler: async (event: unknown) => {
        const envelope = readHookEventEnvelopeV1(event);
        if (!envelope) throw new Error('Expected a canonical hook event envelope');
        params.events.push(envelope.eventId);
        if (envelope.eventId === 'agent.resolvePrerequisites') {
          const runtimeSelection = envelope.payload.runtimeSelection;
          params.prerequisiteEnvironments.push(
            runtimeSelection && typeof runtimeSelection === 'object' && !Array.isArray(runtimeSelection)
              ? (runtimeSelection as Readonly<{ env?: unknown }>).env
              : undefined,
          );
          return { decision: 'allow' as const };
        }
        return { GENERIC_AUGMENT: 'yes' };
      },
    };
  };
  return {
    contributes: {
      agentDefinitionsById: new Map([['codex', {
        id: 'codex',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: 'happier.agent.codex',
        definition: { id: 'codex' },
      }]]),
      activationTargets: Object.freeze([]),
      managedDependencies: Object.freeze([]),
    },
    hookHandlersByHookId: new Map([
      ['agent.resolvePrerequisites', [createHandler('agent.resolvePrerequisites')]],
      ['agent.spawnEnv.augment', [createHandler('agent.spawnEnv.augment')]],
    ]),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

describe('resolveSpawnChildEnvironment provider authorization ordering', () => {
  it('re-runs plugin decision prerequisites with final materialized environment during composition', async () => {
    const events: string[] = [];
    const prerequisiteEnvironments: unknown[] = [];
    const resolveRuntimePrerequisites = vi.fn(async () => {
      events.push('agent-runtime-prerequisite');
      return { ok: true as const };
    });
    const pluginRuntimeRegistry = createRuntimeRegistry({
      events,
      prerequisiteEnvironments,
    });
    const common = {
      happyHomeDir: '/tmp/happier-provider-ordering',
      pluginRuntimeRegistry,
      options: {
        directory: '/repo',
        machineId: 'machine-a',
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: { resolveRuntimePrerequisites },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      providerBindingContext: {
        v: 1 as const,
        agentTargetKey: 'codex',
        connectionId: 'pc_gateway',
        modelId: 'model-a',
      },
    };

    const prerequisite = await resolveSpawnChildEnvironment({
      ...common,
      providerBindingPrerequisitesOnly: true,
    });
    expect(prerequisite.ok).toBe(true);
    expect(events).toEqual(['agent-runtime-prerequisite', 'agent.resolvePrerequisites']);

    events.push('provider-authorized');
    const full = await resolveSpawnChildEnvironment({
      ...common,
      runtimePrerequisitesAlreadyResolved: true,
      connectedServiceAuth: {
        env: { PI_CODING_AGENT_DIR: 'C:\\materialized\\pi-agent' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });
    expect(full).toMatchObject({ ok: true, extraEnvForChild: { GENERIC_AUGMENT: 'yes' } });
    expect(events).toEqual([
      'agent-runtime-prerequisite',
      'agent.resolvePrerequisites',
      'provider-authorized',
      'agent.resolvePrerequisites',
      'agent.spawnEnv.augment',
    ]);
    expect(prerequisiteEnvironments).toEqual([
      undefined,
      { PI_CODING_AGENT_DIR: 'C:\\materialized\\pi-agent' },
    ]);
    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
  });
});
