import { describe, expect, it } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent, AgentAcpRuntimeOptions,
  AgentSessionOpenRequest, AgentSessionRuntimeContext, AgentExecutionRunRuntimeContextV1, AgentExecutionRunOpenRequest, AgentExecutionRunEvent, AgentExecutionRunRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createKimiAgentRuntime } from '../../../../../../../packages/plugins/kimi/src/agent/runtime/factory';
import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from './createPublicAcpSession';
import { createKimiLoopbackModel, KIMI_FIXTURE_BACKGROUND, KIMI_FIXTURE_FOREGROUND,
  type KimiLoopbackModelOptions } from '../../testkit/kimiLoopbackModel';
import { withTempDir } from '@/testkit/fs/tempDir';

const executable = process.env.HAPPIER_TEST_KIMI_PATH?.trim();
type Event = AgentSessionRuntimeEvent;

async function fixture(options: KimiLoopbackModelOptions, run: (input: {
  runtime: AgentSessionRuntime;
  model: Awaited<ReturnType<typeof createKimiLoopbackModel>>;
  events: Event[];
  permissions: unknown[];
  setApproval(value: boolean): void;
  start(): Promise<void>;
  continuation(): Promise<Extract<Event, { kind: 'turn-start' }>>;
}) => Promise<void>) {
  await withTempDir('kimi-public-real-', async directory => {
    const model = await createKimiLoopbackModel(directory, options);
    const lifetime = new AbortController();
    const events: Event[] = [];
    const permissions: unknown[] = [];
    let approval = true;
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.kimi', agentId: 'kimi', signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
      systemTools: { resolve: async () => ({ toolId: 'kimi-cli', launch: { kind: 'binary', executablePath: executable! } }) },
      interactions: { request: async (_request, input) => {
        permissions.push(input?.permissionContext);
        return approval ? { status: 'approved' as const } : { status: 'declined' as const };
      } },
      media: { async registerSourceRoot() { throw new Error('Unexpected generated media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const factory = await createKimiAgentRuntime({ plugin: { id: 'happier.agent.kimi', version: '0.0.0' },
      agent: { id: 'kimi' }, signal: lifetime.signal });
    if (!factory.sessions) throw new Error('Missing Kimi session factory');
    const context = { signal: lifetime.signal, protocols: { acp: {
      open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => createPublicAcpSession(request, options, dependencies),
    } } } as AgentSessionRuntimeContext;
    let runtime: AgentSessionRuntime | undefined;
    try {
      runtime = await factory.sessions.open({ kind: 'create', sessionId: 'public-kimi', cwd: model.workspace,
        launchEnvironment: { values: { KIMI_CODE_HOME: model.home, KIMI_DISABLE_TELEMETRY: '1' },
          unset: Object.keys(process.env).filter(key => /^(KIMI_|OPENAI_|ANTHROPIC_)/u.test(key)
            && key !== 'KIMI_CODE_HOME' && key !== 'KIMI_DISABLE_TELEMETRY') },
      }, context);
      const session = runtime;
      session.watch(event => { events.push(event); });
      await run({ runtime: session, model, events, permissions, setApproval: value => { approval = value; },
        async start() {
          await session.send({ inputIds: ['input-parent'], input: { text: 'Run the isolated background fixture.' },
            delivery: { kind: 'newTurn', turnId: 'parent' }, causalPermissionAuthority: {
              kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
            } });
          await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'parent'), { timeout: 15_000 }).toBe(true);
          expect(events).toContainEqual(expect.objectContaining({ kind: 'message-delta', text: KIMI_FIXTURE_FOREGROUND }));
        },
        async continuation() {
          await model.releaseBackground();
          await expect.poll(() => events.some(event => event.kind === 'turn-start' && event.startedBy === 'provider'), { timeout: 15_000 }).toBe(true);
          const start = events.find((event): event is Extract<Event, { kind: 'turn-start' }> => event.kind === 'turn-start' && event.startedBy === 'provider');
          if (!start) throw new Error('Missing native continuation');
          return start;
        },
      });
    } finally {
      model.releaseContinuation();
      await model.releaseBackground();
      await runtime?.dispose();
      lifetime.abort();
      await model.close();
    }
  });
}

describe.skipIf(!executable || process.platform === 'win32')('official Kimi through public ACP factory', () => {
  it.each([false, true])('publishes continuation output and plan=%s before its terminal', async continuationPlan => {
    await fixture({ continuationPlan }, async ({ start, continuation, model, events }) => {
      await start();
      const turn = await continuation();
      expect(turn).toMatchObject({ causedByTurnId: 'parent', agentTurnId: '1' });
      model.releaseContinuation();
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === turn.turnId), { timeout: 15_000 }).toBe(true);
      const output = events.findIndex(event => event.kind === 'message-delta' && event.turnId === turn.turnId && event.text === KIMI_FIXTURE_BACKGROUND);
      expect(output).toBeGreaterThan(-1);
      expect(output).toBeLessThan(events.findIndex(event => event.kind === 'turn-complete' && event.turnId === turn.turnId));
      if (continuationPlan) expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', turnId: turn.turnId, toolName: 'TodoWrite' }));
    });
  }, 60_000);

  it('retains the original permission authority after a later broader foreground', async () => {
    await fixture({ interveningForeground: true, continuationTool: true }, async ({ start, continuation, runtime, model, events, permissions, setApproval }) => {
      await start();
      await runtime.send({ inputIds: ['input-later'], input: { text: 'Complete another foreground turn.' },
        delivery: { kind: 'newTurn', turnId: 'later' }, causalPermissionAuthority: {
          kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo',
        } });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'later')).toBe(true);
      const turn = await continuation();
      setApproval(false);
      model.releaseContinuation();
      await expect.poll(() => events.some(event => event.kind === 'turn-cancelled' && event.turnId === turn.turnId), { timeout: 15_000 }).toBe(true);
      expect(permissions.at(-1)).toMatchObject({ turnId: turn.turnId, causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      } });
      expect(await model.continuationExecuted()).toBe(false);
    });
  }, 60_000);

  it('cancels the real autonomous turn, fences its output and admits the next foreground', async () => {
    await fixture({}, async ({ start, continuation, runtime, model, events }) => {
      await start();
      const turn = await continuation();
      await expect(runtime.cancel!({ turnId: turn.turnId, reason: 'user' })).resolves.toMatchObject({ status: 'requested' });
      model.releaseContinuation();
      await expect.poll(() => events.some(event => event.kind === 'turn-cancelled' && event.turnId === turn.turnId), { timeout: 15_000 }).toBe(true);
      expect(events.some(event => event.kind === 'message-delta' && event.turnId === turn.turnId && event.text === KIMI_FIXTURE_BACKGROUND)).toBe(false);
      expect(await runtime.send({ inputIds: ['next'], input: { text: 'Next foreground.' }, delivery: { kind: 'newTurn', turnId: 'next' },
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      })).toEqual({ status: 'admitted' });
      await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === 'next'), { timeout: 15_000 }).toBe(true);
    });
  }, 60_000);
});

it.skipIf(!executable || process.platform === 'win32')('opens the official Kimi factory in execution-run scope with the same journal observer', async () => {
  await withTempDir('kimi-run-real-', async directory => {
    const model = await createKimiLoopbackModel(directory, { plain: true });
    const signal = new AbortController().signal;
    const events: AgentExecutionRunEvent[] = [];
    let native: AgentExecutionRunRuntime | undefined;
    let declaredObserver = false;
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.kimi', agentId: 'kimi', signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'kimi-cli', launch: { kind: 'binary', executablePath: executable! } }) },
      interactions: { request: async () => ({ status: 'approved' as const }) },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const factory = await createKimiAgentRuntime({ plugin: { id: 'happier.agent.kimi', version: '0.0.0' }, agent: { id: 'kimi' }, signal });
    const context = { signal, protocols: { acp: {
      openExecutionRunV1: (request: AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) => {
        declaredObserver = typeof options.providerTurnSource === 'function';
        return createPublicAcpExecutionRun(request, options, dependencies);
      },
    } } } as AgentExecutionRunRuntimeContextV1;
    try {
      native = await factory.sessions!.executionRunContextV1!.open({ kind: 'create', runId: 'kimi-run', cwd: model.workspace,
        profile: { pluginId: 'happier.agent.kimi', localId: 'kimi' }, input: { text: 'Complete this isolated run.' },
        localInputId: 'run-input', launchEnvironment: { values: { KIMI_CODE_HOME: model.home, KIMI_DISABLE_TELEMETRY: '1' },
          unset: Object.keys(process.env).filter(key => /^(KIMI_|OPENAI_|ANTHROPIC_)/u.test(key)
            && key !== 'KIMI_CODE_HOME' && key !== 'KIMI_DISABLE_TELEMETRY') },
      }, context);
      native.watch(event => { events.push(event); });
      await expect.poll(() => events.some(event => event.kind === 'run-complete'), { timeout: 15_000 }).toBe(true);
      expect(declaredObserver).toBe(true);
      expect(model.getRequestCount()).toBe(1);
      expect(events.some(event => event.kind === 'run-failed')).toBe(false);
    } finally { await native?.dispose(); await model.close(); }
  });
}, 60_000);
