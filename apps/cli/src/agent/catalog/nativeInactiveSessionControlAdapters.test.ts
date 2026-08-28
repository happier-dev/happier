import { describe, expect, it, vi } from 'vitest';

import { buildTestCodexRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptorV1 } from '@/testkit/runtimeDescriptorFixtures';
import {
  type AgentRuntime,
  type AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { routeSessionUsageLimitRecoveryCheckNow } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';

import {
  createNativeInactiveCatalogAdapter,
  createNativeInactiveGoalAdapter,
  createNativeInactiveUsageAdapter,
} from './nativeInactiveSessionControlAdapters';

function rawSession(id: string): RawSessionRecord {
  return {
    id,
    active: false,
    path: '/repo',
    machineId: 'machine-local',
    metadata: '{}',
    metadataVersion: 1,
    encryptionMode: 'plain',
  } as unknown as RawSessionRecord;
}

function metadata() {
  return {
    path: '/repo',
    host: 'host-local',
    machineId: 'machine-local',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      providerSessionId: 'thread-1',
    }),
  };
}

function runtimeRegistryFixture(params: Readonly<{
  sessions: AgentSessionRuntimeFactory;
  isCurrent?: () => boolean;
  runtime?: AgentRuntime;
  createRuntime?: () => Promise<AgentRuntime>;
  release?: () => Promise<void>;
  includeRuntimeLease?: boolean;
  goalSet?: Readonly<{
    fields: readonly ('objective' | 'status' | 'tokenBudget')[];
    writableStatuses?: readonly ('active' | 'paused' | 'complete')[];
  }>;
}>): Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  acquire(): Promise<PluginRuntimeRegistryLease>;
}> {
  const isCurrent = params.isCurrent ?? (() => true);
  const runtime: AgentRuntime = params.runtime ?? { sessions: params.sessions };
  const contribution = {
    id: 'codex',
    pluginId: 'codex-plugin',
    richDefinition: {
      provenance: 'first_party',
      definition: {
        id: 'codex',
        title: 'Codex',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create'],
            delivery: ['newTurn'],
            cancel: true,
            goals: {
              inactive: {
                get: true,
                clear: true,
                set: params.goalSet ?? { fields: ['objective', 'status', 'tokenBudget'] },
              },
              source: 'goals',
            },
            catalog: { inactive: ['vendorPlugins', 'skills'] },
            usageLimitRecovery: { inactive: ['checkNow'] },
            workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
          },
        },
      },
    },
  };
  // This fixture supplies the exact runtime-registry boundary consumed by inactive controls;
  // unrelated registry families are intentionally omitted.
  const registry = {
    contributes: {
      agentDefinitionsById: new Map([['codex', contribution]]),
    },
    agentRuntimesByAgentId: new Map(params.includeRuntimeLease === false ? [] : [['codex', {
      pluginId: 'codex-plugin',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      generation: 'generation-1',
      hasPrimaryRuntime: true,
      isCurrent,
      createRuntime: params.createRuntime ?? (async () => runtime),
    }]]),
    activateContributionsOnDemand: async () => [],
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  return {
    registry,
    acquire: async () => ({
      registry,
      source: 'ephemeral',
      durableRevision: -1,
      release: params.release ?? (async () => undefined),
    }),
  };
}

function commonRouteParams(sessionId: string) {
  return {
    token: 'token',
    sessionId,
    rawSession: rawSession(sessionId),
    metadata: metadata(),
    currentMachineId: 'machine-local',
    ctx: null,
    mode: 'plain' as const,
    callLiveSessionRpc: vi.fn(),
  };
}

describe('native inactive Agent session controls', () => {
  it('does not expose a retired catalog-adapter fallback when no native facet is declared', () => {
    const legacyList = vi.fn(async () => ({ skills: [{ id: 'legacy-skill' }] }));
    const retiredParams = {
      agentId: 'codex',
      legacy: { listSkills: legacyList },
      native: { vendorPlugins: false, skills: false },
    } as unknown as Parameters<typeof createNativeInactiveCatalogAdapter>[0];

    const adapter = createNativeInactiveCatalogAdapter(retiredParams);

    expect(adapter).not.toHaveProperty('listSkills');
    expect(legacyList).not.toHaveBeenCalled();
  });

  it('routes goals through the current native facet and returns its canonical work-state publication', async () => {
    const set = vi.fn(async (mutation, context) => {
      expect(mutation).toEqual({ objective: 'Ship G6', status: 'active' });
      expect(context.invokedAtMs).toEqual(expect.any(Number));
      expect(context.session).toMatchObject({
        id: 'goal-session',
        cwd: '/repo',
        activity: 'inactive',
        providerSessionId: 'thread-1',
      });
      const published = await context.goalSource.publish({
        sourceSequence: 1,
        observedAtMs: 100,
        items: [{
          localId: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship G6',
          updatedAtMs: 100,
        }],
        primaryLocalId: 'goal:thread-1',
      });
      expect(published.status).toBe('applied');
      return { status: 'applied' as const, revision: 'provider-1' };
    });
    const fixture = runtimeRegistryFixture({
      sessions: {
        goals: { set, get: vi.fn(), clear: vi.fn() },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveGoalAdapter({
      agentId: 'codex',
      native: { get: true, set: true, clear: true },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    const result = await routeSessionGoalControl({
      ...commonRouteParams('goal-session'),
      operation: 'set',
      request: { objective: 'Ship G6', status: 'active' },
      resolveAdapter: async () => adapter,
    });

    expect(result).toMatchObject({
      status: 'applied',
      metadata: {
        sessionWorkStateV1: {
          v: 1,
          primaryItemId: expect.any(String),
          items: [expect.objectContaining({ title: 'Ship G6', status: 'active' })],
        },
      },
    });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an inactive goal mutation exceeds the declared native fields', async () => {
    const set = vi.fn(async () => ({ status: 'applied' as const, revision: 'unexpected' }));
    const fixture = runtimeRegistryFixture({
      goalSet: { fields: ['objective'] },
      sessions: {
        goals: { set, get: vi.fn(), clear: vi.fn() },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveGoalAdapter({
      agentId: 'codex',
      native: { get: true, set: true, clear: true },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionGoalControl({
      ...commonRouteParams('goal-fields-session'),
      operation: 'set',
      request: { objective: 'Ship G6', status: 'active' },
      resolveAdapter: async () => adapter,
    })).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'inactive_agent_goal_field_unsupported' },
    });
    expect(set).not.toHaveBeenCalled();
  });

  it('denies a generation that becomes stale during native catalog invocation without legacy fallback', async () => {
    let current = true;
    const fixture = runtimeRegistryFixture({
      isCurrent: () => current,
      sessions: {
        catalog: {
          async list() {
            current = false;
            return { status: 'ok', kind: 'skills', items: [] };
          },
        },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveCatalogAdapter({
      agentId: 'codex',
      native: { vendorPlugins: true, skills: true },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionCatalogControl({
      ...commonRouteParams('catalog-session'),
      operation: 'skills',
      resolveAdapter: async () => adapter,
    })).resolves.toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'inactive_agent_runtime_generation_retired',
    });
  });

  it('routes usage recovery through the native inactive facet', async () => {
    const execute = vi.fn(async (_request, context) => {
      expect(context.session.activity).toBe('inactive');
      return { status: 'ready' as const };
    });
    const fixture = runtimeRegistryFixture({
      sessions: {
        usageLimitRecovery: { execute },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-session'),
      ctx: null,
      request: { sessionId: 'usage-session', agentId: 'codex' },
      stageUsageLimitRecoveryMutation: vi.fn(async () => undefined),
      resolveAdapter: async () => adapter,
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'usage-session' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'checkNow' }),
      expect.objectContaining({ session: expect.objectContaining({ activity: 'inactive' }) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not call inactive usage recovery when the runtime factory resolves after generation retirement', async () => {
    let current = true;
    let resolveRuntime!: (runtime: AgentRuntime) => void;
    const lateRuntime = new Promise<AgentRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const execute = vi.fn(async () => ({ status: 'ready' as const }));
    const createRuntime = vi.fn(async () => await lateRuntime);
    const release = vi.fn(async () => undefined);
    const sessions: AgentSessionRuntimeFactory = {
      usageLimitRecovery: { execute },
      open: async () => { throw new Error('not used'); },
    };
    const fixture = runtimeRegistryFixture({
      sessions,
      isCurrent: () => current,
      createRuntime,
      release,
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    const checking = routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-retired-during-runtime-create'),
      ctx: null,
      request: { sessionId: 'usage-retired-during-runtime-create', agentId: 'codex' },
      stageUsageLimitRecoveryMutation: vi.fn(async () => undefined),
      resolveAdapter: async () => adapter,
    });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    current = false;
    resolveRuntime({ sessions });

    await expect(checking).resolves.toMatchObject({
      ok: false,
      errorCode: 'inactive_agent_runtime_generation_retired',
      status: 'inactive',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps inactive issue intent and durable backoff state with the host adapter when a native facet exists', async () => {
    const execute = vi.fn(async () => ({ status: 'ready' as const }));
    const fixture = runtimeRegistryFixture({
      sessions: {
        usageLimitRecovery: { execute },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      backoffPolicy: {
        providerId: 'pi',
        fallbackBackoffEnvKey: 'HAPPIER_TEST_FALLBACK_BACKOFF_MS',
        maxAttemptsEnvKey: 'HAPPIER_TEST_MAX_ATTEMPTS',
        defaultFallbackBackoffMs: 60_000,
        defaultMaxAttempts: 3,
      },
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });
    const stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);
    const occurredAt = Date.now();
    const resetAtMs = occurredAt + 60_000;

    const result = await routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-host-state-session'),
      ctx: null,
      credentials: {
        token: 'token',
        encryption: null,
      },
      rawSession: {
        ...rawSession('usage-host-state-session'),
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          agentId: 'pi',
          agentTurnId: 'turn-1',
          occurredAt,
          usageLimit: {
            v: 1,
            resetAtMs,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
          },
        },
      } as RawSessionRecord,
      request: { sessionId: 'usage-host-state-session', agentId: 'codex' },
      stageUsageLimitRecoveryMutation,
      resolveAdapter: async () => adapter,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      metadata: {
        sessionUsageLimitRecoveryV1: {
          issueFingerprint: `usage-limit:pi:turn-1:${occurredAt}:${resetAtMs}`,
          resetAtMs,
          nextCheckAtMs: resetAtMs,
          attemptCount: 1,
          maxAttempts: 3,
        },
      },
    });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'runtime.usageLimitRecovery',
      source: 'daemon',
      deliveryClass: 'durable_required',
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports native usage recovery unavailable when the declared current runtime is absent', async () => {
    const fixture = runtimeRegistryFixture({
      includeRuntimeLease: false,
      sessions: {
        usageLimitRecovery: { execute: vi.fn() },
        open: async () => { throw new Error('not used'); },
      },
    });
    const adapter = createNativeInactiveUsageAdapter({
      agentId: 'codex',
      native: { checkNow: true, consumeResetCredit: false },
      dependencies: { acquireRuntimeRegistryLease: fixture.acquire },
    });

    await expect(routeSessionUsageLimitRecoveryCheckNow({
      ...commonRouteParams('usage-absent-session'),
      ctx: null,
      request: { sessionId: 'usage-absent-session', agentId: 'codex' },
      stageUsageLimitRecoveryMutation: vi.fn(async () => undefined),
      resolveAdapter: async () => adapter,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'inactive_agent_runtime_unavailable',
      status: 'inactive',
    });
  });

});
