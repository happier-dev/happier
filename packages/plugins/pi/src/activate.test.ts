import type {
  AgentExecutionRunOpenRequest,
  AgentRuntimeContext,
  AgentRuntimeFactoryContext,
  AgentSessionControlContext,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginJsonStreamClient, PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from './agent/contributions/runtime.js';
import { piExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { PLUGIN_MANIFEST } from './manifest.js';

type Capture = {
  specs: unknown[];
  written: JsonValue[];
  listener?: (record: JsonValue) => void | Promise<void>;
};

function createContext(capture: Capture, sessionId = 'pi-host-session-1') {
  const client: PluginJsonStreamClient = {
    write: async (value) => { capture.written.push(value); },
    subscribe(listener) {
      capture.listener = listener;
      return { dispose: () => { if (capture.listener === listener) capture.listener = undefined; } };
    },
    dispose: async () => undefined,
  };
  const processExit = new Promise<Awaited<ReturnType<PluginProtocolClientHandle<'jsonStream'>['wait']>>>(() => undefined);
  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client,
    process: {
      pid: 123,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => processExit,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
    wait: () => processExit,
    dispose: async () => undefined,
  };
  const services = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    exec: {
      systemTools: {
        resolve: vi.fn(async () => ({
          executable: Object.freeze({
            kind: 'systemTool' as const,
            id: 'pi-cli',
          }),
          executablePath: '/managed/pi',
        })),
      },
      clients: {
        spawn: vi.fn(async (spec: unknown) => {
          capture.specs.push(spec);
          return handle;
        }),
      },
    },
  };
  const common = {
    plugin: { id: 'happier.agent.pi', version: '0.0.0' },
    contribution: { id: 'pi', qualifiedId: 'happier.agent.pi/agents/pi' },
    surface: 'agent' as const,
    signal: new AbortController().signal,
    services,
    ui: {},
    agent: { id: 'pi' },
    protocols: { acp: { open: async () => { throw new Error('Pi is not ACP'); } } },
  };
  return {
    factory: {
      plugin: common.plugin,
      agent: common.agent,
      signal: common.signal,
    } as AgentRuntimeFactoryContext,
    session: {
      ...common,
      session: { id: sessionId },
      workState: {},
    } as AgentSessionRuntimeContext,
    execution: common as AgentRuntimeContext,
  };
}

async function waitForWrittenCount(capture: Capture, count: number): Promise<void> {
  await vi.waitFor(() => expect(capture.written).toHaveLength(count));
}

async function ack(capture: Capture, index: number, data?: JsonValue): Promise<void> {
  const command = capture.written[index] as { id?: unknown; type?: unknown };
  if (typeof command.id !== 'string' || typeof command.type !== 'string') throw new Error('missing Pi command');
  await capture.listener?.({
    type: 'response', id: command.id, command: command.type, success: true,
    ...(data === undefined ? {} : { data }),
  });
}

async function reject(capture: Capture, index: number, error: string): Promise<void> {
  const command = capture.written[index] as { id?: unknown; type?: unknown };
  if (typeof command.id !== 'string' || typeof command.type !== 'string') throw new Error('missing Pi command');
  await capture.listener?.({
    type: 'response',
    id: command.id,
    command: command.type,
    success: false,
    error,
  });
}

async function createPiRuntime(context: AgentRuntimeFactoryContext) {
  const activation = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
  });
  const factory = activation.registration('agents', 'pi')?.factory;
  if (!factory) throw new Error('Expected Pi Agent factory');
  const runtime = await factory(context);
  await activation.dispose();
  return runtime;
}

describe('activate', () => {
  it('commits the complete Pi Agent aggregate through manifest-derived registration rights', async () => {
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      expect(testkit.registrations()).toContainEqual({ family: 'agents', localId: 'pi' });
    } finally {
      await testkit.dispose();
    }
  });

  it('registers native Pi session and execution-run factories with no V1 compatibility fallback', async () => {
    const activation = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    const registration = activation.registration('agents', 'pi');
    expect(registration).toMatchObject({ factory: expect.any(Function) });
    expect(registration?.externalSessions).toEqual(piExternalSessionsContribution);
    expect(Object.keys(registration?.externalSessions ?? {}).sort()).toEqual([
      'listCandidates',
      'pageTranscript',
      'readAfterTranscript',
      'resolveLinkIdentity',
      'resolveLinkedIdentity',
      'resolveSource',
    ]);
    expect(Object.keys(registration?.externalSessionObservation ?? {}).sort()).toEqual([
      'describeResource',
      'observeResource',
      'reconcileResource',
    ]);
    expect(registration?.externalSessionHooks).toBeUndefined();
    expect(registration?.externalSessionTakeover).toBeUndefined();
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture);
    if (!registration?.factory) throw new Error('Expected Pi Agent factory');
    const runtime = await registration.factory(context.factory);
    expect(runtime.sessions).toEqual({
      open: expect.any(Function),
      usageLimitRecovery: { execute: expect.any(Function) },
    });
    for (const activity of ['active', 'inactive'] as const) {
      const controlContext = {
        signal: context.factory.signal,
        session: {
          id: 'pi-host-session-1',
          cwd: '/tmp/pi-workspace',
          activity,
          connectedAccounts: [],
        },
      } as unknown as AgentSessionControlContext;
      await expect(runtime.sessions.usageLimitRecovery?.execute(
        { kind: 'checkNow' },
        controlContext,
      )).resolves.toEqual({
        status: 'waiting',
        retryAfterMs: 600_000,
      });
      await expect(runtime.sessions.usageLimitRecovery?.execute(
        { kind: 'consumeResetCredit', issueFingerprint: 'quota-1' },
        controlContext,
      )).resolves.toMatchObject({
        status: 'unsupported',
        diagnostic: { code: 'pi_reset_credit_unsupported' },
      });
    }
    expect(runtime.executionRuns).toEqual({ open: expect.any(Function) });
    await activation.dispose();
  });

  it('projects an exact acknowledged execution-run abort as one cancelled terminal', async () => {
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-execution-cancel');
    const runtime = await createPiRuntime(context.factory);
    const opening = runtime.executionRuns!.open({
      kind: 'create',
      runId: 'pi-execution-cancel',
      cwd: '/tmp/pi-workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'pi' },
      input: { text: 'Run until cancelled.' },
    }, context.execution);
    await waitForWrittenCount(capture, 1);
    await ack(capture, 0, { sessionId: 'pi-execution-cancel-provider' });
    await waitForWrittenCount(capture, 2);
    await ack(capture, 1);
    const executionRun = await opening;
    const events: Array<Parameters<Parameters<typeof executionRun.watch>[0]>[0]> = [];
    executionRun.watch((event) => events.push(event));
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'run-start',
        runId: 'pi-execution-cancel',
      }),
    ]);

    const stop = executionRun.stop();
    await waitForWrittenCount(capture, 3);
    expect(capture.written[2]).toEqual(expect.objectContaining({ type: 'abort' }));
    await capture.listener?.({ type: 'agent_end', willRetry: false });
    expect(events).toHaveLength(1);
    await ack(capture, 2);

    await expect(stop).resolves.toEqual({ status: 'requested' });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'run-start',
        runId: 'pi-execution-cancel',
      }),
      expect.objectContaining({
        kind: 'run-cancelled',
        runId: 'pi-execution-cancel',
      }),
    ]);
    await capture.listener?.({ type: 'agent_end', willRetry: false });
    expect(events.filter((event) => event.kind === 'run-cancelled')).toHaveLength(1);
    await executionRun.dispose();
  });

  it('replays output and terminal events received before execution-run open resolves', async () => {
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-execution-early-terminal');
    const runtime = await createPiRuntime(context.factory);
    const opening = runtime.executionRuns!.open({
      kind: 'create',
      runId: 'pi-execution-early-terminal',
      cwd: '/tmp/pi-workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'pi' },
      input: { text: 'Complete before the host subscribes.' },
    }, context.execution);
    await waitForWrittenCount(capture, 1);
    await ack(capture, 0, { sessionId: 'pi-execution-early-terminal-provider' });
    await waitForWrittenCount(capture, 2);
    await capture.listener?.({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'early output' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'early output' }] },
    });
    await capture.listener?.({ type: 'agent_end', willRetry: false });
    await ack(capture, 1);

    const executionRun = await opening;
    const events: Array<Parameters<Parameters<typeof executionRun.watch>[0]>[0]> = [];
    executionRun.watch((event) => events.push(event));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'run-start' }),
      expect.objectContaining({ kind: 'output-delta', text: 'early output' }),
      expect.objectContaining({ kind: 'run-complete' }),
    ]);
    await executionRun.dispose();
  });

  it('publishes a terminal failure when the initial execution-run prompt is rejected', async () => {
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-execution-rejected');
    const runtime = await createPiRuntime(context.factory);
    const opening = runtime.executionRuns!.open({
      kind: 'create',
      runId: 'pi-execution-rejected',
      cwd: '/tmp/pi-workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'pi' },
      input: { text: 'Reject this prompt.' },
    }, context.execution);
    await waitForWrittenCount(capture, 1);
    await ack(capture, 0, { sessionId: 'pi-execution-rejected-provider' });
    await waitForWrittenCount(capture, 2);
    await reject(capture, 1, 'Prompt was not acknowledged');

    const executionRun = await opening;
    const events: Array<Parameters<Parameters<typeof executionRun.watch>[0]>[0]> = [];
    executionRun.watch((event) => events.push(event));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'run-start' }),
      expect.objectContaining({
        kind: 'run-failed',
        diagnostic: expect.objectContaining({ code: 'pi_input_rejected' }),
      }),
    ]);
    await executionRun.dispose();
  });

  it.each(['resume', 'fork'] as const)(
    'rejects undeclared execution-run %s before opening a Pi process',
    async (kind) => {
      const capture: Capture = { specs: [], written: [] };
      const context = createContext(capture, `pi-execution-${kind}`);
      const runtime = await createPiRuntime(context.factory);
      const request = (kind === 'resume'
        ? {
            kind,
            runId: 'pi-execution-resume',
            cwd: '/tmp/pi-workspace',
            profile: { pluginId: 'happier.agent.pi', localId: 'pi' },
            checkpointId: 'checkpoint-1',
          }
        : {
            kind,
            runId: 'pi-execution-fork',
            cwd: '/tmp/pi-workspace',
            profile: { pluginId: 'happier.agent.pi', localId: 'pi' },
            sourceRunId: 'pi-source-run',
          }) satisfies AgentExecutionRunOpenRequest;

      await expect(runtime.executionRuns!.open(request, context.execution))
        .rejects.toThrow(`Pi execution runs do not support ${kind}`);
      expect(capture.specs).toEqual([]);
    },
  );

  it('opens Pi through public services and compacts once with canonical events', async () => {
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture);
    const runtime = await createPiRuntime(context.factory);
    const session = await runtime.sessions!.open({
      kind: 'create',
      sessionId: 'pi-host-session-1',
      cwd: '/tmp/pi-workspace',
      launchEnvironment: { values: { HAPPIER_PI_THINKING_LEVEL: 'medium' }, unset: [] },
    }, context.session);
    expect(capture.specs).toEqual([expect.objectContaining({
      kind: 'jsonStream',
      launch: expect.objectContaining({
        executable: { kind: 'systemTool', id: 'pi-cli' },
        args: ['--mode', 'rpc', '--tools', 'read,bash,edit,write,grep,find,ls', '--thinking', 'medium'],
        env: expect.objectContaining({ NODE_ENV: 'production', DEBUG: '', CI: '1' }),
      }),
    })]);
    const events: unknown[] = [];
    const subscription = session.watch((event) => events.push(event));
    const compacted = session.compact!({
      compactionId: 'host-compact-1',
      trigger: 'manual',
      instructions: 'retain X',
    });
    await waitForWrittenCount(capture, 1);
    expect(capture.written[0]).toMatchObject({ type: 'compact', customInstructions: 'retain X' });
    await capture.listener?.({ type: 'compaction_start', reason: 'manual' });
    await capture.listener?.({
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'kept', firstKeptEntryId: 'entry-1', tokensBefore: 100, estimatedTokensAfter: 30 },
    });
    await ack(capture, 0);
    await expect(compacted).resolves.toEqual({ status: 'admitted' });
    await capture.listener?.({ type: 'compaction_start', reason: 'threshold' });
    await capture.listener?.({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'automatic', firstKeptEntryId: 'entry-2', tokensBefore: 90, estimatedTokensAfter: 25 },
    });
    expect(capture.written.filter((value) => (value as { type?: unknown }).type === 'compact')).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'context-compaction', compactionId: 'host-compact-1', phase: 'started' }),
      expect.objectContaining({ kind: 'context-compaction', compactionId: 'host-compact-1', phase: 'completed' }),
      expect.objectContaining({ kind: 'context-compaction', compactionId: expect.stringMatching(/^pi:/), trigger: 'threshold', phase: 'started' }),
      expect.objectContaining({ kind: 'context-compaction', compactionId: expect.stringMatching(/^pi:/), trigger: 'threshold', phase: 'completed' }),
    ]));
    subscription.dispose();
    await session.dispose();
  });

  it('projects only Pi-declared launch environment values and explicit unsets into the native process', async () => {
    const resolveRuntimePreferences = (
      PI_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
        sessionRuntimePreferences?: Readonly<{
          resolve?: (params: Readonly<{
            settings: Readonly<Record<string, unknown>>;
            processEnv: Readonly<Record<string, string | undefined>>;
            startedBy?: 'terminal' | 'daemon';
          }>) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
        }>;
      }>
    ).sessionRuntimePreferences?.resolve;
    expect(resolveRuntimePreferences).toBeTypeOf('function');

    const preferences = await resolveRuntimePreferences?.({
      settings: {},
      processEnv: {
        OPENAI_API_KEY: 'fixture-openai-key',
        ANTHROPIC_API_KEY: undefined,
        PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
        HOME: '/isolated/home',
        XDG_CONFIG_HOME: '/isolated/xdg',
        USERPROFILE: 'C:\\isolated\\home',
        HAPPIER_PI_THINKING_LEVEL: 'medium',
        UNRELATED_SECRET: 'must-not-reach-pi',
      },
      startedBy: 'daemon',
    });
    expect(preferences).toEqual({
      environmentVariables: {
        HAPPIER_PI_THINKING_LEVEL: 'medium',
        OPENAI_API_KEY: 'fixture-openai-key',
        HOME: '/isolated/home',
        XDG_CONFIG_HOME: '/isolated/xdg',
        USERPROFILE: 'C:\\isolated\\home',
        PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
      },
      unsetEnvironmentVariables: ['ANTHROPIC_API_KEY'],
    });

    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture);
    const runtime = await createPiRuntime(context.factory);
    const session = await runtime.sessions!.open({
      kind: 'create',
      sessionId: 'pi-host-session-environment',
      cwd: '/tmp/pi-workspace',
      launchEnvironment: {
        values: preferences?.environmentVariables as Readonly<Record<string, string>>,
        unset: preferences?.unsetEnvironmentVariables as readonly string[],
      },
    }, context.session);

    expect(capture.specs).toEqual([expect.objectContaining({
      launch: expect.objectContaining({
        env: {
          HAPPIER_PI_THINKING_LEVEL: 'medium',
          OPENAI_API_KEY: 'fixture-openai-key',
          HOME: '/isolated/home',
          XDG_CONFIG_HOME: '/isolated/xdg',
          USERPROFILE: 'C:\\isolated\\home',
          PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
          NODE_ENV: 'production',
          DEBUG: '',
          CI: '1',
        },
        unsetEnvKeys: ['ANTHROPIC_API_KEY'],
      }),
    })]);
    expect(JSON.stringify(capture.specs)).not.toContain('UNRELATED_SECRET');
    expect(JSON.stringify(capture.specs)).not.toContain('must-not-reach-pi');
    await session.dispose();

    const executionCapture: Capture = { specs: [], written: [] };
    const executionContext = createContext(executionCapture, 'pi-execution-run-environment');
    const executionRuntime = await createPiRuntime(executionContext.factory);
    const executionRunPromise = executionRuntime.executionRuns!.open({
      kind: 'create',
      runId: 'pi-execution-run-environment',
      cwd: '/tmp/pi-workspace',
      profile: { pluginId: 'happier.agent.pi', localId: 'pi' },
      input: { text: 'Check the workspace.' },
      launchEnvironment: {
        values: preferences?.environmentVariables as Readonly<Record<string, string>>,
        unset: preferences?.unsetEnvironmentVariables as readonly string[],
      },
    }, executionContext.execution);
    await waitForWrittenCount(executionCapture, 1);
    await ack(executionCapture, 0, { sessionId: 'pi-execution-provider-session' });
    await waitForWrittenCount(executionCapture, 2);
    await ack(executionCapture, 1);
    await executionCapture.listener?.({ type: 'agent_start' });
    const executionRun = await executionRunPromise;
    expect(executionCapture.specs).toEqual([expect.objectContaining({
      launch: expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: 'fixture-openai-key',
          PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
          HOME: '/isolated/home',
          XDG_CONFIG_HOME: '/isolated/xdg',
          USERPROFILE: 'C:\\isolated\\home',
        }),
        unsetEnvKeys: ['ANTHROPIC_API_KEY'],
      }),
    })]);
    expect(JSON.stringify(executionCapture.specs)).not.toContain('UNRELATED_SECRET');
    await executionRun.dispose();
  });
});
