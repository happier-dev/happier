import { describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

const pluginId = 'acme.provider-ordering';
const localAgentId = 'ordering-agent';
const agentId = `${pluginId}/${localAgentId}`;

async function createProviderOrderingFixture(params: Readonly<{
  events: string[];
  prerequisiteEnvironments: unknown[];
}>) {
  const createHookHandler = (eventId: 'agent.resolvePrerequisites' | 'agent.spawnEnv.augment') => async (payload: unknown): Promise<ProtocolJsonValue> => {
    params.events.push(eventId);
    if (eventId === 'agent.resolvePrerequisites') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected the SDK hook payload');
      const runtimeSelection = Reflect.get(payload, 'runtimeSelection');
      params.prerequisiteEnvironments.push(
        runtimeSelection && typeof runtimeSelection === 'object' && !Array.isArray(runtimeSelection)
          ? Reflect.get(runtimeSelection, 'env')
          : undefined,
      );
      return { decision: 'allow' as const };
    }
    return { GENERIC_AUGMENT: 'yes' };
  };
  return await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{
      manifest: createPluginManifestV2Fixture({
        id: pluginId,
        contributes: {
          agents: [{ id: localAgentId, title: 'Ordering Agent', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
          hooks: [
            { id: 'prerequisites', on: 'agent.resolvePrerequisites', category: 'decision', scope: 'agent', executionKind: 'decide' },
            { id: 'augment', on: 'agent.spawnEnv.augment', category: 'augmentation', scope: 'daemon', executionKind: 'augment' },
          ],
        },
      }),
      files: {
        'daemon.mjs': `import { createRuntime } from './runtime.mjs';
export function activate(api) {
  api.agents.register('${localAgentId}', createRuntime, {
    sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
  });
}`,
        'runtime.mjs': `export function createRuntime() {
  return { sessions: { async open(request) {
    return { sessionId: request.sessionId, async send() { return { status: 'admitted' }; },
      watch() { return { dispose() {} }; }, async dispose() {} };
  } } };
}`,
      },
      // Public SDK callbacks are the fixture plugin's authored behavior. Source
      // admission, registration policy, activation and dispatch remain real.
      instantiateCommittedModule: (module) => ({
        ...module,
        activate(api: PluginApi) {
          if (typeof module.activate !== 'function') throw new Error('Expected authored activation');
          module.activate(api);
          api.hooks.register('prerequisites', createHookHandler('agent.resolvePrerequisites'));
          api.hooks.register('augment', createHookHandler('agent.spawnEnv.augment'));
        },
      }),
    }],
  });
}

describe('resolveSpawnChildEnvironment provider authorization ordering', () => {
  it('re-runs plugin decision prerequisites with final materialized environment during composition', async () => {
    const events: string[] = [];
    const prerequisiteEnvironments: unknown[] = [];
    const resolveRuntimePrerequisites = vi.fn(async () => {
      events.push('agent-runtime-prerequisite');
      return { ok: true as const };
    });
    const fixture = await createProviderOrderingFixture({
      events,
      prerequisiteEnvironments,
    });
    try {
      await fixture.registry.activateContributionsOnDemand([
        { pluginId, family: 'agents', localId: localAgentId },
      ]);
      const common = {
        happyHomeDir: fixture.happyHomeDir,
        pluginRuntimeRegistry: fixture.registry,
        resolvedAgentId: agentId,
        options: {
          directory: '/repo',
          machineId: 'machine-a',
          backendTarget: { kind: 'backend' as const, backendId: agentId, sourceKind: 'built_in' as const },
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
          agentTargetKey: agentId,
          connectionId: 'pc_gateway',
          modelId: 'model-a',
        },
      };

      const prerequisite = await resolveSpawnChildEnvironment({
        ...common,
        providerBindingPrerequisitesOnly: true,
      });
      expect(prerequisite, JSON.stringify(prerequisite)).toMatchObject({ ok: true });
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
    } finally {
      await fixture.dispose();
    }
  });
});
