import { describe, expect, it, vi } from 'vitest';

const hookDispatch = vi.hoisted(() => vi.fn());

vi.mock('@/plugins/runtime/hooks/execution/dispatchDaemonSpawnHookEvent', () => ({
  dispatchDaemonSpawnHookEvent: hookDispatch,
}));

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('resolveSpawnChildEnvironment provider authorization ordering', () => {
  it('runs every decision prerequisite in the authorized prerequisite pass and does not repeat it during composition', async () => {
    const events: string[] = [];
    const resolveRuntimePrerequisites = vi.fn(async () => {
      events.push('agent-runtime-prerequisite');
      return { ok: true as const };
    });
    hookDispatch.mockImplementation(async ({ event }: { event: { eventId: string } }) => {
      events.push(event.eventId);
      return event.eventId === 'agent.resolvePrerequisites'
        ? { aggregate: { executionKind: 'decide', result: { decision: 'allow' } }, outcomes: [] }
        : { aggregate: { executionKind: 'augment', result: { GENERIC_AUGMENT: 'yes' } }, outcomes: [] };
    });
    const common = {
      happyHomeDir: '/tmp/happier-provider-ordering',
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
    });
    expect(full).toMatchObject({ ok: true, extraEnvForChild: { GENERIC_AUGMENT: 'yes' } });
    expect(events).toEqual([
      'agent-runtime-prerequisite',
      'agent.resolvePrerequisites',
      'provider-authorized',
      'agent.spawnEnv.augment',
    ]);
    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
  });
});
