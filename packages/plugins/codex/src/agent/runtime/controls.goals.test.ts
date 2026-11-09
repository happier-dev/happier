import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionGoalControlContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';
import { PluginError } from '@happier-dev/plugin-sdk';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { createCodexNativeSessionControls } from './controls.js';
import { createCodexAgentRuntime } from './engine.js';

describe('Codex live Session Goal routing', () => {
  it.each(['failed', 'interrupted'] as const)('keeps a usage-limited Goal blocked after %s work', async status => {
    const engine = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '0.0.0' },
      agent: { id: 'codex' }, signal: new AbortController().signal });
    if (!engine.sessions) throw new Error('Missing Codex Session factory');
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(event));
      fixture.emitNotification('thread/goal/updated', { threadId: 'fresh-thread', goal: { threadId: 'fresh-thread',
        objective: 'Keep the goal', status: 'usageLimited', updatedAt: 1_776_272_460 } });
      await session.send({ inputIds: ['failed-recovery-input'], input: { text: 'Try to continue.' },
        delivery: { kind: 'newTurn', turnId: 'failed-recovery-turn' } });
      fixture.emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status,
        ...(status === 'failed' ? { error: { message: 'Usage limit reached', codexErrorInfo: 'usageLimitExceeded' } } : {}) } });
      await vi.waitFor(() => expect(events.some(event => event.kind === (status === 'failed' ? 'turn-failed' : 'turn-cancelled'))).toBe(true));
      expect(fixture.requests.filter(request => request.method === 'thread/goal/set')).toEqual([]);
      await session.dispose();
    }, { sessionFactory: engine.sessions });
  });
  it.each(['usageLimited', 'paused', 'complete'] as const)('reactivates only a still usage-limited native Goal after successful work (%s)', async currentStatus => {
    const engine = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '0.0.0' },
      agent: { id: 'codex' }, signal: new AbortController().signal });
    if (!engine.sessions) throw new Error('Missing Codex Session factory');
    let rereadGoal: Record<string, unknown> | undefined;
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch(event => events.push(event));
      const publish = vi.fn(async (_snapshot: Parameters<AgentSessionGoalControlContext['goalSource']['publish']>[0]) => (
        { status: 'applied' as const, revision: 'goal-recovery' }
      ));
      const context = { signal: new AbortController().signal, services: { exec: fixture.exec },
        session: { id: 'actual-happier-session', cwd: fixture.directory, activity: 'active',
          providerSessionId: 'fresh-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish } } as unknown as AgentSessionGoalControlContext;
      const retained = { threadId: 'fresh-thread', objective: 'Finish the retained goal', tokenBudget: 40_000,
        tokensUsed: 7_000, timeUsedSeconds: 90, createdAt: 1_776_272_400, updatedAt: 1_776_272_460 };
      fixture.emitNotification('thread/goal/updated', { threadId: 'fresh-thread', goal: { ...retained, status: 'usageLimited' } });
      await session.send({ inputIds: ['recovery-input'], input: { text: 'Continue after quota recovery.' },
        delivery: { kind: 'newTurn', turnId: 'recovery-turn' } });
      // Native truth may have changed without a Goal notification reaching this runtime.
      rereadGoal = { ...retained, status: currentStatus };
      fixture.emitNotification('turn/completed', { threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' } });
      await vi.waitFor(() => expect(events.some(event => event.kind === 'turn-complete')).toBe(true));
      if (currentStatus === 'usageLimited') {
        await vi.waitFor(() => expect(fixture.requests.filter(request => request.method === 'thread/goal/set'))
          .toEqual([{ method: 'thread/goal/set', params: { threadId: 'fresh-thread', status: 'active' } }]));
      } else expect(fixture.requests.filter(request => request.method === 'thread/goal/set')).toEqual([]);
      await expect(session.goals!.get(context)).resolves.toMatchObject({ status: 'applied' });
      expect(publish.mock.lastCall?.[0]).toMatchObject({ items: [{ title: retained.objective,
        status: currentStatus === 'usageLimited' ? 'active' : currentStatus, tokenBudget: 40_000,
        tokensUsed: 7_000, timeUsedSeconds: 90 }] });
      await session.dispose();
    }, { sessionFactory: engine.sessions, goalRead: () => { const result = rereadGoal; rereadGoal = undefined; return result; } });
  });
  it('refuses a live factory-control bypass with zero new native processes', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      await fixture.openConfiguredSession();
      const spawnClient = vi.spyOn(fixture.exec.clients, 'spawn');
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal, services: { exec: fixture.exec },
        session: { id: 'actual-happier-session', cwd: fixture.directory, activity: 'active',
          providerSessionId: 'fresh-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish: async () => ({ status: 'applied' as const, revision: 'bypass' }) },
      } as unknown as AgentSessionGoalControlContext);
      expect(spawnClient).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code: 'codex_goal_read_failed',
        details: { stage: 'client_creation', errorClass: 'PluginError' } }, goalControlFailure: { phase: 'native_effect' } });
    });
  });
  it('uses the owning loaded thread with zero new processes, including a foreign caller, and retains its client after failure', async () => {
    const engine = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '0.0.0' }, agent: { id: 'codex' }, signal: new AbortController().signal,
    });
    const sessions = engine.sessions;
    if (!sessions?.goals) throw new Error('Missing Codex Session Goals');
    const boundary: NonNullable<Parameters<typeof withCodexNativeAttachFixture>[1]> = {
      sessionFactory: sessions, goalThreadsVisibleOnlyWhenLoaded: true,
    };
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      const goals = session.goals ?? sessions.goals!;
      const publish = vi.fn(async (_snapshot: Parameters<AgentSessionGoalControlContext['goalSource']['publish']>[0]) => (
        { status: 'applied' as const, revision: 'goal-1' }
      ));
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec, logger: { debug: vi.fn() } },
        session: { id: 'actual-happier-session', cwd: fixture.directory, activity: 'active',
          providerSessionId: 'fresh-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish },
      } as unknown as AgentSessionGoalControlContext;
      const run = vi.spyOn(fixture.exec, 'run');
      const spawn = vi.spyOn(fixture.exec, 'spawn');
      const spawnClient = vi.spyOn(fixture.exec.clients, 'spawn');
      // The caller's native environment is deliberately unrelated to the target.
      // Runtime-bound controls must never consult it or start another process.
      expect(await goals.get(context)).toMatchObject({ status: 'applied' });
      expect(publish.mock.lastCall?.[0]).toMatchObject({ items: [] });
      expect(await goals.set({ objective: 'Finish the live objective', status: 'paused' }, context))
        .toMatchObject({ status: 'applied' });
      expect(await goals.set({ status: 'paused' }, context)).toMatchObject({ status: 'applied' });
      expect(publish.mock.lastCall?.[0]).toMatchObject({ items: [{ title: 'Finish the live objective', status: 'paused' }] });
      boundary.goalFailure = { code: -32600, message: 'thread not found: fresh-thread' };
      expect(await goals.clear(context)).toMatchObject({ status: 'unavailable',
        diagnostic: { code: 'codex_goal_clear_failed', details: { stage: 'thread/goal/clear' } } });
      boundary.goalFailure = undefined;
      expect(await goals.get(context)).toMatchObject({ status: 'applied' });
      expect(publish.mock.lastCall?.[0]).toMatchObject({ items: [{ title: 'Finish the live objective' }] });
      expect(await goals.clear(context)).toMatchObject({ status: 'applied' });
      expect(await goals.get(context)).toMatchObject({ status: 'applied' });
      expect(publish.mock.lastCall?.[0]).toMatchObject({ items: [] });
      expect(run.mock.calls.length + spawn.mock.calls.length + spawnClient.mock.calls.length).toBe(0);
      await session.dispose();
      const replacement = await fixture.openConfiguredSession('fresh-thread');
      run.mockClear(); spawn.mockClear(); spawnClient.mockClear();
      const replacementGoals = replacement.goals ?? sessions.goals!;
      const callerContext = { ...context, services: { ...context.services,
        exec: { ...fixture.exec, clients: { ...fixture.exec.clients, spawn: async () => { throw new Error('Caller scope must not launch'); } } },
      }, session: { ...context.session, launchEnvironment: { values: { CODEX_HOME: '/caller/home', CODEX_SQLITE_HOME: '/caller/sqlite' }, unset: [] } } };
      expect(await replacementGoals.set({ objective: 'Keep the replacement', status: 'paused' }, callerContext)).toMatchObject({ status: 'applied' });
      expect(await replacementGoals.get(callerContext)).toMatchObject({ status: 'applied' });
      expect(publish.mock.lastCall?.[0]).toMatchObject({ items: [{ title: 'Keep the replacement' }] });
      expect(run.mock.calls.length + spawn.mock.calls.length + spawnClient.mock.calls.length).toBe(0);
      await replacement.dispose();
    }, boundary);
  });
});

describe('Codex inactive Session Goal scope', () => {
  it('passes the admitted target Home and SQLite scope to the control process for every operation', async () => {
    const launches: Array<Readonly<{ argv: readonly string[]; env?: Readonly<Record<string, string | undefined>> }>> = [];
    await withCodexNativeAttachFixture(async fixture => {
      const active = await fixture.openConfiguredSession();
      await active.dispose();
      launches.length = 0;
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec },
        session: { id: 'target-session', cwd: fixture.directory, activity: 'inactive', providerSessionId: 'fresh-thread', connectedAccounts: [],
          launchEnvironment: { values: { CODEX_HOME: fixture.directory, CODEX_SQLITE_HOME: `${fixture.directory}/target-sqlite` }, unset: [] } },
        goalSource: { publish: async () => ({ status: 'applied' as const, revision: 'target' }) },
      } as unknown as AgentSessionGoalControlContext;
      const goals = createCodexNativeSessionControls().goals;
      expect(await goals.set({ objective: 'Target goal', status: 'paused' }, context)).toMatchObject({ status: 'applied' });
      expect(await goals.get(context)).toMatchObject({ status: 'applied' });
      expect(await goals.clear(context)).toMatchObject({ status: 'applied' });
      expect(launches).toHaveLength(3);
      for (const launch of launches) {
        expect(launch.env).toMatchObject(context.session.launchEnvironment?.values ?? {});
        expect(launch.argv).toContain(`sqlite_home=${JSON.stringify(`${fixture.directory}/target-sqlite`)}`);
      }
    }, { observer: { recordAppServerRequest() {}, recordLaunch: input => { launches.push(input); } } });
  });
});

describe('Codex Goal native failure evidence', () => {
  it('does not reinterpret an initialization refusal as unsupported Goals', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal,
        services: { exec: fixture.exec },
        session: { id: 'happier-session', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish: vi.fn() },
      } as unknown as AgentSessionGoalControlContext);
      expect(result).toMatchObject({ status: 'unavailable', retryable: true,
        diagnostic: { code: 'codex_goal_read_failed', details: { stage: 'initialize', errorCode: '-32600' } } });
    }, { initializeFailure: { code: -32600, message: 'goals feature is disabled' } });
  });

  it.each(['get', 'set', 'clear'] as const)('reports disabled native Goals as unsupported for %s', async operation => {
    // rust-v0.162.1 thread_goal_processor.rs rejects all three methods with
    // this exact error before looking up or resuming the requested thread.
    await withCodexNativeAttachFixture(async fixture => {
      const publish = vi.fn();
      const debug = vi.fn();
      const context = {
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { debug } },
        session: { id: 'happier-session', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish },
      } as unknown as AgentSessionGoalControlContext;
      const goals = createCodexNativeSessionControls().goals;
      const result = operation === 'set'
        ? await goals.set({ objective: 'PRIVATE_TOKEN' }, context)
        : await goals[operation](context);
      expect(result).toMatchObject({ status: 'unsupported',
        diagnostic: { code: 'codex_goals_disabled', details: { stage: `thread/goal/${operation}`, errorCode: '-32600' } },
        goalControlFailure: { phase: 'native_effect' } });
      expect(publish).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN');
    }, { goalFailure: { code: -32600, message: 'goals feature is disabled' } });
  });

  it.each([
    [-32600, 'thread not found: PRIVATE_TOKEN', 'thread_not_found'],
    [-32600, 'ephemeral thread does not support goals: PRIVATE_TOKEN', 'ephemeral_thread'],
    [-32600, 'thread metadata does not match requested id', 'thread_identity_mismatch'],
    [-32600, 'PRIVATE_TOKEN goals feature is disabled', 'unclassified'],
    [-32000, 'goals feature is disabled', 'unclassified'],
  ] as const)('keeps native refusal %s content-free (%s)', async (code, message, condition) => {
    await withCodexNativeAttachFixture(async fixture => {
      const debug = vi.fn();
      const publish = vi.fn();
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { debug } },
        session: { id: 'happier-session', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish },
      } as unknown as AgentSessionGoalControlContext);
      expect(result).toMatchObject({ status: 'unavailable', retryable: true,
        diagnostic: { code: 'codex_goal_read_failed' }, goalControlFailure: { phase: 'native_effect' } });
      expect(debug.mock.calls.some(([, fields]) => fields?.condition === condition && fields.stage === 'thread/goal/get')).toBe(true);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('PRIVATE_TOKEN');
      expect(publish).not.toHaveBeenCalled();
    }, { goalFailure: { code, message } });
  });

  it('retains a recognized SDK native launch refusal without its private data', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal,
        services: { exec: { ...fixture.exec, systemTools: { resolve: async () => {
          throw new PluginError({ code: 'plugin_exec_native_launch_unavailable',
            message: 'PRIVATE_TOKEN /private/home', details: { token: 'PRIVATE_TOKEN' } });
        } } } },
        session: { id: 'external-goal', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
        goalSource: { publish: vi.fn() },
      } as unknown as AgentSessionGoalControlContext);
      expect(result).toMatchObject({ diagnostic: { details: { stage: 'client_creation',
        errorClass: 'PluginError', errorCode: 'plugin_exec_native_launch_unavailable' } } });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|private\/home/);
    });
  });

  it.each(['get', 'set', 'clear'] as const)('retains safe startup, initialize and RPC causes for %s', async operation => {
    for (const stage of ['client_creation', 'initialize', `thread/goal/${operation}`] as const) {
      await withCodexNativeAttachFixture(async fixture => {
        // Process/IPC creation is the external boundary; controls and client stay real.
        const exec = stage === 'client_creation'
          ? { ...fixture.exec, clients: { ...fixture.exec.clients, spawn: async () => {
            throw Object.assign(new TypeError('PRIVATE_TOKEN /private/home goal text'), { code: 'EACCES' });
          } } }
          : fixture.exec;
        const publish = vi.fn();
        const context = {
          signal: new AbortController().signal,
          services: { exec, logger: { debug() {}, warn() {} } },
          session: { id: 'session-goal', cwd: fixture.directory, activity: 'inactive',
            providerSessionId: 'unpersisted-thread', connectedAccounts: [], launchEnvironment: fixture.launchEnvironment },
          goalSource: { publish },
        } as unknown as AgentSessionGoalControlContext;
        const goals = createCodexNativeSessionControls().goals;
        const result = operation === 'set'
          ? await goals.set({ objective: 'PRIVATE_TOKEN goal text' }, context)
          : await goals[operation](context);
        expect(result).toMatchObject({ status: 'unavailable', retryable: true,
          diagnostic: { code: `codex_goal_${operation === 'get' ? 'read' : operation === 'set' ? 'write' : 'clear'}_failed`,
            details: { stage, errorClass: stage === 'client_creation' ? 'TypeError' : 'JsonRpcApplicationError',
              errorCode: stage === 'client_creation' ? 'EACCES' : stage === 'initialize' ? '-32000' : '-32600' } },
          goalControlFailure: { phase: 'native_effect' } });
        if ('diagnostic' in result) expect(AgentRuntimeDiagnosticDataV1Schema.safeParse(result.diagnostic).success).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|private\/home|goal text|unpersisted-thread/);
        expect(publish).not.toHaveBeenCalled();
      }, stage === 'initialize' ? { initializeFailure: { code: -32000, message: 'PRIVATE_TOKEN /private/home goal text' } } : {});
    }
  });
});
