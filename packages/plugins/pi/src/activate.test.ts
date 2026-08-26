import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentExecutionRunOpenRequest,
  AgentRuntimeContext,
  AgentRuntimeFactoryContext,
  AgentSessionControlContext,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginJsonStreamClient, PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { piExternalSessionsContribution } from './agent/externalSessions/contribution.js';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from './agent/contributions/catalog.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
} from './agent/auth/services/requestAuth/index.js';

type Capture = {
  specs: unknown[];
  written: JsonValue[];
  listener?: (record: JsonValue) => void | Promise<void>;
  disposeCount?: number;
};

type ConnectedAccountsFixture = Readonly<{
  getBinding: ReturnType<typeof vi.fn>;
  materialize: ReturnType<typeof vi.fn>;
  requestSelection: ReturnType<typeof vi.fn>;
  watch: ReturnType<typeof vi.fn>;
}>;

function disconnectedConnectedAccounts(): ConnectedAccountsFixture {
  return {
    getBinding: vi.fn(async () => null),
    materialize: vi.fn(),
    requestSelection: vi.fn(),
    watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
      listener({ kind: 'resync' });
      return { dispose() {} };
    }),
  };
}

function createContext(
  capture: Capture,
  sessionId = 'pi-host-session-1',
  connectedAccounts: ConnectedAccountsFixture = disconnectedConnectedAccounts(),
) {
  const client: PluginJsonStreamClient = {
    write: async (value) => {
      const record = value as Readonly<{ id?: unknown; type?: unknown }>;
      if (typeof record.id === 'string' && record.type === 'get_commands') {
        await capture.listener?.({
          type: 'response',
          id: record.id,
          command: 'get_commands',
          success: true,
          data: { commands: [] },
        });
        return;
      }
      if (typeof record.id === 'string' && record.type === 'get_session_stats') {
        await capture.listener?.({
          type: 'response',
          id: record.id,
          command: 'get_session_stats',
          success: true,
          data: { contextUsage: null },
        });
        return;
      }
      capture.written.push(value);
    },
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
    dispose: async () => { capture.disposeCount = (capture.disposeCount ?? 0) + 1; },
  };
  const services = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    exec: {
      run: vi.fn(async () => ({
        termination: {
          observed: { kind: 'exit' as const, exitCode: 0 },
          requestedBy: { kind: 'none' as const },
        },
        stdout: new TextEncoder().encode('pi 0.82.1'),
        stderr: new Uint8Array(),
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
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
    connectedAccounts,
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
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'hooks',
      'settings',
      'systemTools',
      'ui',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      PI_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('commits the complete Pi Agent aggregate through manifest-derived registration rights', async () => {
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      expect(testkit.registrations()).toContainEqual({ family: 'agents', localId: 'pi' });
      expect(testkit.registrations()).not.toContainEqual(expect.objectContaining({ family: 'hooks' }));
    } finally {
      await testkit.dispose();
    }
  });

  it('registers the static Connected Account launch facts without retaining a private aggregate', async () => {
    const activation = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    try {
      expect(activation.registration('agents', 'pi')?.connectedAccountLaunch).toEqual({
        requestAuthUses: [{
          purpose: 'anthropic-model-request',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://api.anthropic.com',
            headerNames: ['authorization'],
          },
        }, {
          purpose: 'openai-codex-model-request',
          materialization: {
            kind: 'httpHeaders',
            origin: 'https://chatgpt.com',
            headerNames: ['authorization', 'chatgpt-account-id'],
          },
        }],
        stateSharingDescriptor: expect.objectContaining({
          providerSupportStatus: 'supported',
          authIsolation: {
            mode: 'materialized_home',
            secretEntries: ['auth.json'],
          },
        }),
      });
      expect(activation.registration('agents', 'pi')?.connectedAccountLaunch?.stateSharingDescriptor)
        .not.toHaveProperty('providerId');
      expect(PI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('connectedServices');
    } finally {
      await activation.dispose();
    }
  });

  it('registers native Pi session and execution-run factories with no V1 compatibility fallback', async () => {
    const activation = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    const registration = activation.registration('agents', 'pi');
    expect(registration).toMatchObject({ factory: expect.any(Function) });
    expect(registration?.externalSessions).toEqual({
      resolveSource: expect.any(Function),
      listCandidates: expect.any(Function),
      resolveLinkIdentity: expect.any(Function),
      resolveLinkedIdentity: expect.any(Function),
      pageTranscript: expect.any(Function),
      readAfterTranscript: expect.any(Function),
    });
    expect(registration?.externalSessions).not.toBe(piExternalSessionsContribution);
    expect(registration?.externalSessions?.resolveSource).not.toBe(
      piExternalSessionsContribution.resolveSource,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledRequest = {
      signal: cancelled.signal,
      deadlineAtMs: Date.now() + 30_000,
      maxSerializedBytes: 64 * 1024,
      source: {},
    } as never;
    expect(registration?.externalSessions?.resolveSource(cancelledRequest)).toEqual(
      piExternalSessionsContribution.resolveSource(cancelledRequest),
    );
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
    expect(registration?.externalSessionTakeover).toEqual({
      resolveLaunch: expect.any(Function),
    });
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
        diagnostic: expect.objectContaining({
          code: 'pi_provider_session_error',
          message: 'Pi provider rejected the prompt before acceptance: Prompt was not acknowledged',
        }),
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
        args: ['--mode', 'rpc', '--thinking', 'medium'],
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

  it('loads the host-resolved native tool manifest beside the request-auth extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-native-tools-'));
    try {
      const agentDir = join(root, 'agent');
      await mkdir(agentDir, { recursive: true });
      const capture: Capture = { specs: [], written: [] };
      const context = createContext(capture);
      const resolveNativeBridge = vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'pi-host-session-1',
        directory: '/tmp/pi-workspace',
        systemPrompt: 'Use the registered Happier tools.',
        tools: [{
          name: 'action_spec_search',
          title: 'Search actions',
          description: 'Search the effective Action catalog.',
          inputSchema: {
            type: 'object' as const,
            properties: { query: { type: 'string' as const } },
            required: ['query'],
            additionalProperties: false,
          },
        }],
        launch: {
          executablePath: '/managed/happier',
          argsPrefix: ['tools', 'call', '--agent-bridge'],
        },
      }));
      const sessionContext = {
        ...context.session,
        session: {
          ...context.session.session,
          services: { happierTools: { resolveNativeBridge } },
        },
      } as unknown as AgentSessionRuntimeContext;
      const runtime = await createPiRuntime(context.factory);
      const session = await runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-host-session-1',
        cwd: '/tmp/pi-workspace',
        startupInstructions: {
          v: 1,
          id: 'happier.coding_agent',
          revision: 1,
          instructions: 'Use the registered Happier tools.',
        },
        launchEnvironment: {
          values: { PI_CODING_AGENT_DIR: agentDir },
          unset: [],
        },
      }, sessionContext);

      expect(resolveNativeBridge).toHaveBeenCalledWith({
        systemPrompt: 'Use the registered Happier tools.',
      }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      const spec = capture.specs[0] as Readonly<{ launch?: Readonly<{ args?: readonly string[] }> }>;
      const args = spec.launch?.args ?? [];
      const extensionIndex = args.indexOf('--extension');
      const configIndex = args.indexOf('--happier-tools-config');
      expect(extensionIndex).toBeGreaterThanOrEqual(0);
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(args[extensionIndex + 1]).toContain('happier-pi-tools-bridge.js');
      const configPath = args[configIndex + 1];
      expect(configPath).toBeTruthy();
      expect(JSON.parse(await readFile(configPath!, 'utf8'))).toMatchObject({
        systemPrompt: 'Use the registered Happier tools.',
        tools: [{ name: 'action_spec_search' }],
      });

      await session.dispose();
      await expect(readFile(configPath!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes public direct OpenAI and Anthropic purposes before spawning Pi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-public-direct-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), `${JSON.stringify({
      openrouter: { type: 'api_key', key: 'pre-existing-provider-key' },
    }, null, 2)}\n`);
    await writeFile(
      join(agentDir, 'extensions', 'happier-pi-request-auth.js'),
      'stale request-auth asset\n',
    );
    const disposedPurposes: string[] = [];
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => (
        purpose === 'openai-api-key' || purpose === 'anthropic-api-key'
          ? {
              purpose,
              service: purpose === 'openai-api-key'
                ? { pluginId: 'happier.voice.openai', localId: 'openai' }
                : { pluginId: 'happier.agent.claude', localId: 'anthropic' },
              account: purpose === 'openai-api-key'
                ? {
                    service: { pluginId: 'happier.voice.openai', localId: 'openai' },
                    accountId: 'openai-account',
                  }
                : {
                    service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
                    accountId: 'anthropic-account',
                  },
              target: { kind: 'account' as const, displayName: purpose },
            }
          : null
      )),
      materialize: vi.fn(async (purpose: string) => ({
        kind: 'environment' as const,
        env: purpose === 'openai-api-key'
          ? { OPENAI_API_KEY: 'sk-openai-public' }
          : { ANTHROPIC_API_KEY: 'sk-anthropic-public' },
      })),
      requestSelection: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listener({ kind: 'resync' });
        return { dispose: () => { disposedPurposes.push(purpose); } };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-direct', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    try {
      const session = await runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-public-direct',
        cwd: '/tmp/pi-workspace',
        launchEnvironment: {
          values: {
            PI_CODING_AGENT_DIR: agentDir,
          },
          unset: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
        },
      }, context.session);

      expect(connectedAccounts.watch.mock.calls.map(([purpose]) => purpose)).toEqual([
        'anthropic-model-request',
        'openai-codex-model-request',
        'openai-api-key',
        'anthropic-api-key',
      ]);
      expect(connectedAccounts.getBinding.mock.calls).toEqual([
        ['anthropic-model-request', { signal: context.session.signal }],
        ['openai-codex-model-request', { signal: context.session.signal }],
        ['openai-api-key', { signal: context.session.signal }],
        ['anthropic-api-key', { signal: context.session.signal }],
      ]);
      expect(connectedAccounts.materialize.mock.calls).toEqual([
        [
          'openai-api-key',
          { kind: 'environment', keys: ['OPENAI_API_KEY'] },
          {
            signal: context.session.signal,
            expectedAccount: {
              service: { pluginId: 'happier.voice.openai', localId: 'openai' },
              accountId: 'openai-account',
            },
          },
        ],
        [
          'anthropic-api-key',
          { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
          {
            signal: context.session.signal,
            expectedAccount: {
              service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
              accountId: 'anthropic-account',
            },
          },
        ],
      ]);
      expect(capture.specs[0]).toMatchObject({
        launch: {
          env: {
            PI_CODING_AGENT_DIR: agentDir,
            OPENAI_API_KEY: 'sk-openai-public',
            ANTHROPIC_API_KEY: 'sk-anthropic-public',
            NODE_ENV: 'production',
            DEBUG: '',
            CI: '1',
          },
          unsetEnvKeys: [
            PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
            PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
          ],
        },
      });
      await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toBe(
        `${JSON.stringify({
          openrouter: { type: 'api_key', key: 'pre-existing-provider-key' },
          openai: { type: 'api_key', key: 'sk-openai-public' },
          anthropic: { type: 'api_key', key: 'sk-anthropic-public' },
        }, null, 2)}\n`,
      );
      const { ModelRuntime } = await import('pi-coding-agent-0821');
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        allowModelNetwork: false,
      });
      await expect(modelRuntime.getAuth('openai', {
        env: { OPENAI_API_KEY: 'lower-precedence-ambient-key' },
      })).resolves.toMatchObject({
        auth: { apiKey: 'sk-openai-public' },
        source: 'stored credential',
      });
      await expect(readFile(
        join(agentDir, 'extensions', 'happier-pi-request-auth.js'),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
      await session.dispose();
      expect(disposedPurposes.sort()).toEqual([
        'anthropic-api-key',
        'anthropic-model-request',
        'openai-api-key',
        'openai-codex-model-request',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not spawn Pi after a qualified account invalidates after direct materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-invalidated-before-open-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}\n');
    const account = {
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      accountId: 'openai-account',
    } as const;
    const listeners = new Map<string, (event: { kind: 'resync' }) => void | Promise<void>>();
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => purpose === 'openai-api-key'
        ? {
            purpose,
            service: account.service,
            account,
            target: { kind: 'account' as const, displayName: 'OpenAI' },
          }
        : null),
      materialize: vi.fn(async () => {
        await listeners.get('openai-api-key')?.({ kind: 'resync' });
        return { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-openai-public' } };
      }),
      requestSelection: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listeners.set(purpose, listener);
        listener({ kind: 'resync' });
        return { dispose() {} };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-invalidated-before-open', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    try {
      await expect(runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-invalidated-before-open',
        cwd: '/tmp/pi-workspace',
        launchEnvironment: { values: { PI_CODING_AGENT_DIR: agentDir }, unset: [] },
      }, context.session)).rejects.toThrow('invalidated before opening');
      expect(connectedAccounts.materialize).toHaveBeenCalledWith(
        'openai-api-key',
        { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        expect.objectContaining({ expectedAccount: account }),
      );
      expect(capture.specs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails malformed public materialization before spawning Pi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-public-malformed-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}\n');
    const disposedPurposes: string[] = [];
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => purpose === 'openai-api-key'
        ? {
            purpose,
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            target: { kind: 'account' as const, displayName: 'OpenAI' },
          }
        : null),
      materialize: vi.fn(async () => ({ kind: 'environment' as const, env: { UNEXPECTED: 'secret' } })),
      requestSelection: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listener({ kind: 'resync' });
        return { dispose: () => { disposedPurposes.push(purpose); } };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-malformed', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    try {
      await expect(runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-public-malformed',
        cwd: '/tmp/pi-workspace',
        launchEnvironment: {
          values: {
            PI_CODING_AGENT_DIR: agentDir,
            [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(root, 'request-auth.json'),
          },
          unset: [],
        },
      }, context.session)).rejects.toThrow(/OPENAI_API_KEY/u);
      expect(capture.specs).toEqual([]);
      await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toBe('{}\n');
      expect(disposedPurposes.sort()).toEqual([
        'anthropic-api-key',
        'anthropic-model-request',
        'openai-api-key',
        'openai-codex-model-request',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unexpected public purpose binding before materialization or spawn', async () => {
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => purpose === 'openai-api-key'
        ? {
            purpose,
            service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            target: { kind: 'account' as const, displayName: 'Wrong service' },
          }
        : null),
      materialize: vi.fn(),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listener({ kind: 'resync' });
        return { dispose() {} };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-wrong-service', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);

    await expect(runtime.sessions!.open({
      kind: 'create',
      sessionId: 'pi-public-wrong-service',
      cwd: '/tmp/pi-workspace',
    }, context.session)).rejects.toThrow(/unexpected Connected Account service/u);
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(capture.specs).toEqual([]);
  });

  it('converts a Claude setup token to bounded direct Anthropic auth while preserving Codex request auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-public-setup-token-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}\n');
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => {
        if (purpose === 'anthropic-model-request') {
          return {
            purpose,
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            account: {
              service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
              accountId: 'claude-subscription-account',
            },
            target: { kind: 'account' as const, displayName: 'Claude setup token' },
          };
        }
        if (purpose === 'openai-codex-model-request') {
          return {
            purpose,
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            target: { kind: 'account' as const, displayName: 'Codex OAuth' },
          };
        }
        return null;
      }),
      materialize: vi.fn(async () => ({
        kind: 'environment' as const,
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-setup-token-public' },
      })),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listener({ kind: 'resync' });
        return { dispose() {} };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-setup-token', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    try {
      const session = await runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-public-setup-token',
        cwd: '/tmp/pi-workspace',
        launchEnvironment: {
          values: {
            PI_CODING_AGENT_DIR: agentDir,
            [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(root, 'request-auth.json'),
          },
          unset: ['ANTHROPIC_API_KEY'],
        },
      }, context.session);

      expect(connectedAccounts.materialize).toHaveBeenCalledExactlyOnceWith(
        'anthropic-model-request',
        { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
        {
          signal: context.session.signal,
          expectedAccount: {
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            accountId: 'claude-subscription-account',
          },
        },
      );
      expect(capture.specs[0]).toMatchObject({
        launch: {
          env: expect.objectContaining({ ANTHROPIC_API_KEY: 'claude-setup-token-public' }),
        },
      });
      expect(capture.specs[0]?.launch).not.toHaveProperty('unsetEnvKeys');
      expect(JSON.stringify(capture.specs[0])).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
      await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toBe(
        `${JSON.stringify({
          anthropic: { type: 'api_key', key: 'claude-setup-token-public' },
        }, null, 2)}\n`,
      );
      const requestAuthSource = await readFile(
        join(agentDir, 'extensions', 'happier-pi-request-auth.js'),
        'utf8',
      );
      expect(requestAuthSource).toContain('openai-codex-model-request');
      expect(requestAuthSource).not.toContain('anthropic-model-request');
      await session.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Claude OAuth on request auth when materialization explicitly requires it beside direct OpenAI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-public-mixed-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth.json'), '{}\n');
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => {
        if (purpose === 'anthropic-model-request') {
          return {
            purpose,
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            account: {
              service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
              accountId: 'claude-oauth-account',
            },
            target: { kind: 'account' as const, displayName: 'Claude OAuth' },
          };
        }
        if (purpose === 'openai-api-key') {
          return {
            purpose,
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            account: {
              service: { pluginId: 'happier.voice.openai', localId: 'openai' },
              accountId: 'openai-api-key-account',
            },
            target: { kind: 'account' as const, displayName: 'OpenAI API key' },
          };
        }
        return null;
      }),
      materialize: vi.fn(async (purpose: string) => {
        if (purpose === 'anthropic-model-request') {
          throw new PluginError({
            code: 'plugin_connected_account_claude_subscription_oauth_request_auth_required',
          });
        }
        return {
          kind: 'environment' as const,
          env: { OPENAI_API_KEY: 'sk-openai-mixed' },
        };
      }),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listener({ kind: 'resync' });
        return { dispose() {} };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-mixed', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    try {
      const session = await runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-public-mixed',
        cwd: '/tmp/pi-workspace',
        launchEnvironment: {
          values: {
            PI_CODING_AGENT_DIR: agentDir,
            [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(root, 'request-auth.json'),
          },
          unset: ['OPENAI_API_KEY'],
        },
      }, context.session);

      expect(connectedAccounts.materialize.mock.calls).toEqual([
        [
          'anthropic-model-request',
          { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
          {
            signal: context.session.signal,
            expectedAccount: {
              service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
              accountId: 'claude-oauth-account',
            },
          },
        ],
        [
          'openai-api-key',
          { kind: 'environment', keys: ['OPENAI_API_KEY'] },
          {
            signal: context.session.signal,
            expectedAccount: {
              service: { pluginId: 'happier.voice.openai', localId: 'openai' },
              accountId: 'openai-api-key-account',
            },
          },
        ],
      ]);
      expect(capture.specs[0]).toMatchObject({
        launch: { env: expect.objectContaining({ OPENAI_API_KEY: 'sk-openai-mixed' }) },
      });
      await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toBe(
        `${JSON.stringify({ openai: { type: 'api_key', key: 'sk-openai-mixed' } }, null, 2)}\n`,
      );
      const requestAuthSource = await readFile(
        join(agentDir, 'extensions', 'happier-pi-request-auth.js'),
        'utf8',
      );
      expect(requestAuthSource).toContain('anthropic-model-request');
      await session.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not reinterpret an unselected Claude materialization refusal as request auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-public-unselected-claude-refusal-'));
    const agentDir = join(root, 'pi-agent-dir');
    await mkdir(agentDir, { recursive: true });
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async (purpose: string) => purpose === 'anthropic-model-request'
        ? {
            purpose,
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            account: {
              service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
              accountId: 'claude-unselected-refusal-account',
            },
            target: { kind: 'account' as const, displayName: 'Claude account' },
          }
        : null),
      materialize: vi.fn(async () => {
        throw new PluginError({
          code: 'plugin_connected_account_claude_subscription_environment_request_unsupported',
        });
      }),
      requestSelection: vi.fn(),
      watch: vi.fn((_purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listener({ kind: 'resync' });
        return { dispose() {} };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-unselected-claude-refusal', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    try {
      await expect(runtime.sessions!.open({
        kind: 'create',
        sessionId: 'pi-public-unselected-claude-refusal',
        cwd: '/tmp/pi-workspace',
        launchEnvironment: {
          values: { PI_CODING_AGENT_DIR: agentDir },
          unset: [],
        },
      }, context.session)).rejects.toMatchObject({
        code: 'plugin_connected_account_claude_subscription_environment_request_unsupported',
      });
      expect(connectedAccounts.materialize).toHaveBeenCalledExactlyOnceWith(
        'anthropic-model-request',
        { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
        {
          signal: context.session.signal,
          expectedAccount: {
            service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
            accountId: 'claude-unselected-refusal-account',
          },
        },
      );
      expect(capture.specs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves native launch behavior when every public Connected Account purpose is unbound', async () => {
    const capture: Capture = { specs: [], written: [] };
    const connectedAccounts = disconnectedConnectedAccounts();
    const context = createContext(capture, 'pi-public-unbound', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    const session = await runtime.sessions!.open({
      kind: 'create',
      sessionId: 'pi-public-unbound',
      cwd: '/tmp/pi-workspace',
      launchEnvironment: {
        values: { OPENAI_API_KEY: 'native-openai-key' },
        unset: ['ANTHROPIC_API_KEY'],
      },
    }, context.session);

    expect(connectedAccounts.getBinding).toHaveBeenCalledTimes(4);
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(capture.specs[0]).toMatchObject({
      launch: {
        env: expect.objectContaining({ OPENAI_API_KEY: 'native-openai-key' }),
        unsetEnvKeys: ['ANTHROPIC_API_KEY'],
      },
    });
    await session.dispose();
  });

  it('disposes the one Pi session runtime and every purpose watch on a later public resync', async () => {
    const listeners = new Map<string, (event: { kind: 'resync' }) => void>();
    const disposedPurposes: string[] = [];
    const connectedAccounts: ConnectedAccountsFixture = {
      getBinding: vi.fn(async () => null),
      materialize: vi.fn(),
      requestSelection: vi.fn(),
      watch: vi.fn((purpose: string, listener: (event: { kind: 'resync' }) => void) => {
        listeners.set(purpose, listener);
        listener({ kind: 'resync' });
        return { dispose: () => { disposedPurposes.push(purpose); } };
      }),
    };
    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture, 'pi-public-resync', connectedAccounts);
    const runtime = await createPiRuntime(context.factory);
    await runtime.sessions!.open({
      kind: 'create',
      sessionId: 'pi-public-resync',
      cwd: '/tmp/pi-workspace',
    }, context.session);

    listeners.get('openai-api-key')?.({ kind: 'resync' });
    await vi.waitFor(() => expect(capture.disposeCount).toBe(1));
    expect(disposedPurposes.sort()).toEqual([
      'anthropic-api-key',
      'anthropic-model-request',
      'openai-api-key',
      'openai-codex-model-request',
    ]);
  });

  it('projects only Pi-declared launch environment values and explicit unsets into the native process', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    let preferences: Readonly<Record<string, unknown>>;
    try {
      const buildSessionOptions = activation.registration('agents', 'pi')?.cliSessionCommand?.buildSessionOptions;
      expect(buildSessionOptions).toBeTypeOf('function');
      const result = buildSessionOptions?.({
        isExplicitCliSubcommand: true,
        parsed: { agentArgs: [] },
        settings: {},
        environment: {
        OPENAI_API_KEY: 'fixture-openai-key',
        ANTHROPIC_API_KEY: undefined,
        PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
        HOME: '/isolated/home',
        XDG_CONFIG_HOME: '/isolated/xdg',
        USERPROFILE: 'C:\\isolated\\home',
        HAPPIER_PI_THINKING_LEVEL: 'medium',
        UNRELATED_SECRET: 'must-not-reach-pi',
        },
        startOrigin: 'daemon',
      });
      expect(result).toEqual({
        ok: true,
        options: {
          environmentVariables: {
            HAPPIER_PI_THINKING_LEVEL: 'medium',
            OPENAI_API_KEY: 'fixture-openai-key',
            HOME: '/isolated/home',
            XDG_CONFIG_HOME: '/isolated/xdg',
            USERPROFILE: 'C:\\isolated\\home',
            PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
          },
          unsetEnvironmentVariables: ['ANTHROPIC_API_KEY'],
        },
      });
      if (!result || !result.ok) throw new Error('Expected Pi CLI Session options');
      preferences = result.options;
    } finally {
      await activation.dispose();
    }

    const capture: Capture = { specs: [], written: [] };
    const context = createContext(capture);
    const runtime = await createPiRuntime(context.factory);
    const session = await runtime.sessions!.open({
      kind: 'create',
      sessionId: 'pi-host-session-environment',
      cwd: '/tmp/pi-workspace',
      launchEnvironment: {
        values: preferences.environmentVariables as Readonly<Record<string, string>>,
        unset: preferences.unsetEnvironmentVariables as readonly string[],
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
