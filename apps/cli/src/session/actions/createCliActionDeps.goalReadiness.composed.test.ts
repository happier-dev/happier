import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import * as persistence from '@/persistence';
import { createCliActionDeps } from './createCliActionDeps';

const boundary = vi.hoisted(() => ({
  dispatch: null as ((method: string, request: unknown, signal?: AbortSignal) => Promise<unknown>) | null,
  onEnter: null as (() => void) | null,
}));
// Replace only socket I/O. Real RPC budgets, capability handlers, initial
// controls readiness, Action dependencies and trigger admission remain wired.
vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocket: () => createApiSessionSocketStub({ connected: true }),
  createUserScopedSocketConnection: (options: Readonly<{ signal?: AbortSignal }>) => {
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, raw) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object' || !('method' in raw)
        || typeof raw.method !== 'string' || !('params' in raw) || !boundary.dispatch) throw new Error('Unexpected RPC boundary');
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      boundary.onEnter?.();
      return { ok: true, result: await boundary.dispatch(raw.method.slice(raw.method.indexOf(':') + 1), raw.params, options.signal) };
    } });
    return { socket, transport: { connect: async () => {}, destroy: async () => {},
      onDisconnected: () => () => {} } };
  },
}));
vi.mock('@/api/session/connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    const socket = createApiSessionSocketStub({ connected: true });
    return { socket, transport: { connect: async () => {}, disconnect: async () => {}, destroy: async () => {},
      isConnected: () => true, onConnected: () => () => {}, onDisconnected: () => () => {}, onError: () => () => {} } };
  },
}));

describe('Keep going capability discovery during native controls installation', () => {
  let client: ApiSessionClient | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    client?.setSessionRuntimeControls(null);
    await client?.close();
    client = null;
    boundary.dispatch = null;
    boundary.onEnter = null;
    vi.restoreAllMocks();
  });

  it.each(['disabled', 'unavailable'] as const)('keeps native Goal cleanup within the Workflow owner when its service is %s', async state => {
    // Server feature observation and HTTP are genuine transport boundaries.
    // A disabled service retains its triggers; it must not prevent native Goals.
    const reads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      reads.push(String(url));
      throw new Error('Unavailable Workflow service must not receive trigger reads');
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      reads.push(String(config.url));
      throw new Error('Unavailable Workflow service must not receive trigger writes');
    });
    const deps = createCliActionDeps({ token: 'tok', credentials: { token: 'tok', encryption: null },
      sessionId: 'c123456789012345678901234', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => state === 'disabled'
        ? { status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
          features: { automations: { enabled: true }, workflows: { enabled: false } }, capabilities: {},
        }) }
        : { status: 'error', reason: 'network' },
    });
    if (state === 'disabled') await expect(deps.prepareNativeGoalOwner()).resolves.toBeUndefined();
    else await expect(deps.prepareNativeGoalOwner()).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(reads).toEqual([]);
  });

  it.each(['native', 'unsupported', 'abort'] as const)('retains caller lifetime until %s installation', async scenario => {
    const sessionId = 'c123456789012345678901234';
    client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: sessionId }));
    const session = client;
    boundary.dispatch = (method, request, signal) => session.rpcHandlerManager.invokeLocal(method, request, { signal });
    const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
      machineId: 'goal-machine', metadata: JSON.stringify({ machineId: 'goal-machine', path: '/repo' }) });
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId: 'goal-machine' });
    const writes: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
      if (String(url).includes('/v3/automations?')) return { status: 200, data: { automations: [], nextCursor: null } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (config.method !== 'POST' || !config.url?.endsWith('/v3/automations')) throw new Error('Unexpected trigger mutation');
      const input = AutomationDefinitionCreateRequestSchema.parse(config.data);
      writes.push(input.automationId);
      return { status: 200, data: { id: input.automationId, name: input.name, description: null,
        enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1,
        lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: input.workflowDefinitionId,
        scopeSessionId: input.scopeSessionId, executionRecipe: input.executionRecipe,
        assignments: (input.assignments ?? []).map(item => ({ ...item, enabled: true, priority: 0, updatedAt: 1 })),
        triggers: input.triggers.map(item => ({ ...item.trigger, id: item.triggerId, revision: 0,
          createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null })),
      } };
    });
    const deps = createCliActionDeps({ token: 'tok', credentials: { token: 'tok', encryption: null }, sessionId,
      mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
      }) }),
    });
    const controller = new AbortController();
    let settled = false;
    const entered = new Promise<void>(resolve => { boundary.onEnter = resolve; });
    const outcome = deps.workflowAction!({ actionId: 'workflow.trigger.add', input: { lifetimeSession: { sessionId }, target: { kind: 'workflow', ref: 'builtin:keep-going' },
      trigger: { kind: 'schedule', enabled: true,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } },
      context: { surface: 'cli', authority: 'present_user', signal: controller.signal } }).catch((error: unknown) => error)
      .then(value => { settled = true; return value; });
    await Promise.race([entered, outcome.then(() => { throw new Error('Trigger admission settled before capability discovery'); })]);
    // Advance the real transport's omitted-option 20 s deadline; no wall-clock
    // sleep or test-owned replacement timeout is involved.
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled, 'capability discovery must retain controls-readiness lifetime').toBe(false);
    if (scenario === 'abort') {
      controller.abort();
      await Promise.resolve();
      await Promise.resolve();
      await vi.waitFor(() => expect(settled).toBe(true));
    }
    session.setSessionRuntimeControls(scenario === 'unsupported' ? {} : {
      refreshGoal: () => undefined, setGoal: () => undefined, clearGoal: () => undefined,
    });
    await expect(outcome).resolves.toMatchObject(scenario === 'unsupported'
      ? { set: { health: 'available', scopeSessionId: sessionId } }
      : { ok: false, errorCode: scenario === 'native' ? 'native_goal_owner' : 'target_unavailable' });
    expect(writes).toHaveLength(scenario === 'unsupported' ? 1 : 0);
  });
});
