import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  CreateExecutionRunBackendParamsV1,
  CreateSessionRuntimeParamsV1,
  ExecutionRunBackendCreateResultV1,
  ExecutionRunHostBackendV1,
  PluginContextV1,
  SessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk';
import { createPluginContextV1Fixture } from '@happier-dev/plugin-sdk/experimental/testing/adapterHarness';

import { createAntigravityBackendEngine } from './engine.js';
import { buildAntigravityRuntimeDescriptorV1 } from './runtimeDescriptor.js';

function createRuntime(kind: 'sdk' | 'cliPrint'): SessionRuntimeCreateResultV1 {
  return {
    identity: { read: () => ({ providerSessionId: `${kind}-session` }) },
    events: { subscribe: () => () => undefined },
    send: vi.fn(async () => ({ status: 'accepted' as const })),
    cancel: vi.fn(async () => ({ status: 'cancelled' as const })),
    dispose: vi.fn(async () => undefined),
  };
}

function createExecutionRunBackend(kind: 'sdk' | 'cliPrint'): ExecutionRunBackendCreateResultV1 {
  return {
    run: vi.fn(async () => ({ status: 'completed' as const, sessionId: `${kind}-run` })),
    dispose: vi.fn(async () => undefined),
  };
}

function expectHostExecutionRunBackend(
  backend: ExecutionRunBackendCreateResultV1 | undefined,
): asserts backend is ExecutionRunHostBackendV1 {
  expect(backend).toBeDefined();
  expect(typeof (backend as ExecutionRunHostBackendV1).provisionSession).toBe('function');
  expect(typeof (backend as ExecutionRunHostBackendV1).sendPrompt).toBe('function');
  expect(typeof (backend as ExecutionRunHostBackendV1).subscribeMessages).toBe('function');
}

function createFixtureContext(): PluginContextV1 {
  return createPluginContextV1Fixture().ctx;
}

describe('createAntigravityBackendEngine', () => {
  it('dispatches explicit sdk session runtime creation to the localharness branch', async () => {
    const ctx = createFixtureContext();
    const sdkRuntime = createRuntime('sdk');
    const sdk = vi.fn(async () => sdkRuntime);
    const cliPrint = vi.fn(async () => createRuntime('cliPrint'));
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });
    const sessionParams: CreateSessionRuntimeParamsV1 = {
      metadata: { antigravityRuntimeMode: 'sdk' },
    };

    await expect(engine.runtimeCore?.createSessionRuntime(sessionParams)).resolves.toBe(sdkRuntime);
    expect(sdk).toHaveBeenCalledWith({ ctx, sessionParams });
    expect(cliPrint).not.toHaveBeenCalled();
  });

  it('dispatches explicit cliPrint session runtime creation to the cliPrint branch', async () => {
    const ctx = createFixtureContext();
    const cliRuntime = createRuntime('cliPrint');
    const sdk = vi.fn(async () => createRuntime('sdk'));
    const cliPrint = vi.fn(async () => cliRuntime);
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });
    const sessionParams: CreateSessionRuntimeParamsV1 = {
      metadata: {
        antigravityRuntimeMode: 'cliPrint',
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 42,
          selection: {
            agentTargetKey: 'backend:antigravity',
            providerConnectionId: 'pc_work',
            modelId: 'Claude Sonnet 4.6 (Thinking)',
          },
        },
      },
    };

    await expect(engine.runtimeCore?.createSessionRuntime(sessionParams)).resolves.toBe(cliRuntime);
    expect(cliPrint).toHaveBeenCalledWith({ ctx, sessionParams });
    expect(sdk).not.toHaveBeenCalled();
  });

  it('rejects malformed canonical model selection instead of falling back to the bare model field', async () => {
    const ctx = createFixtureContext();
    const engine = createAntigravityBackendEngine(ctx, {
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      metadata: { antigravityRuntimeMode: 'cliPrint' },
      modelSelection: {
        v: 1,
        updatedAt: 42,
        ref: {
          agentTargetKey: 'backend:antigravity',
          providerConnectionId: 'pc_work',
          modelId: '',
        },
      } as never,
      modelId: 'legacy-native',
    })).rejects.toThrow(/model selection/i);
  });

  it('surfaces setup diagnostics for explicit cliPrint when its preflight fails', async () => {
    const ctx = createFixtureContext();
    const sdk = vi.fn(async () => createRuntime('sdk'));
    const cliPrint = vi.fn(async () => createRuntime('cliPrint'));
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
      probes: {
        isCliPrintAvailable: vi.fn(async () => false),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({
      metadata: { antigravityRuntimeMode: 'cliPrint' },
    })).rejects.toMatchObject({
      reasonCode: 'antigravity_runtime_unavailable',
    });
    expect(cliPrint).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
  });

  it('wires the default cliPrint session branch through the plugin exec agent-cli surface', async () => {
    const base = createPluginContextV1Fixture().ctx;
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'cli response\n',
      stderr: '',
    }));
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        exec: {
          ...base.agentRuntime.exec,
          run,
        },
      },
    } as PluginContextV1;
    const engine = createAntigravityBackendEngine(ctx, {
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });

    const runtime = await engine.runtimeCore?.createSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      env: {
        GEMINI_API_KEY: 'gemini-secret',
        GOOGLE_API_KEY: 'google-secret',
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        GOOGLE_CLOUD_PROJECT: 'project-secret',
        GOOGLE_CLOUD_LOCATION: 'location-secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/private/credentials.json',
        ANTIGRAVITY_AUTH_MODE: 'api_key',
        HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'cliPrint',
        SAFE_TEST_ENV: 'kept',
      },
      metadata: {
        antigravityRuntimeMode: 'cliPrint',
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 42,
          selection: {
            agentTargetKey: 'backend:antigravity',
            providerConnectionId: 'pc_work',
            modelId: 'Claude Sonnet 4.6 (Thinking)',
          },
        },
      },
    });
    await expect(runtime?.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-1',
    });

    expect(run).toHaveBeenCalledWith({
      kind: 'agent-cli',
      agentId: 'antigravity',
      args: expect.arrayContaining(['-p', 'hello', '--sandbox', '--add-dir', '/repo']),
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }, expect.objectContaining({
      timeoutMs: expect.any(Number),
    }));
    const args = run.mock.calls[0]?.[0]?.args ?? [];
    expect(args[args.indexOf('-p') + 1]).toBe('hello');
    expect(args).toEqual(expect.arrayContaining(['--model', 'Claude Sonnet 4.6 (Thinking)']));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('uses agy models as the default auto cliPrint availability probe before selecting cliPrint', async () => {
    const base = createPluginContextV1Fixture().ctx;
    const run = vi.fn(async () => ({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'not authenticated',
    }));
    const checkReadiness = vi.fn(async () => ({
      status: 'launchable' as const,
      launchable: [{
        agentId: 'antigravity',
        status: 'launchable' as const,
        scope: 'launch' as const,
        checks: {
          launch: 'passed' as const,
          auth: 'not_checked' as const,
          buildPolicy: 'not_checked' as const,
        },
      }],
      missing: [],
      blocked: [],
    }));
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        exec: {
          ...base.agentRuntime.exec,
          run,
        },
        agents: {
          ...base.agentRuntime.agents,
          cli: {
            ...base.agentRuntime.agents.cli,
            checkReadiness,
          },
        },
      },
    } as PluginContextV1;
    const sdkRuntime = createRuntime('sdk');
    const sdk = vi.fn(async () => sdkRuntime);
    const cliPrint = vi.fn(async () => createRuntime('cliPrint'));
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({
      cwd: '/repo',
      env: { GEMINI_API_KEY: 'sdk-secret' },
      metadata: {},
    })).resolves.toBe(sdkRuntime);

    expect(run).toHaveBeenCalledWith({
      kind: 'agent-cli',
      agentId: 'antigravity',
      args: ['models'],
      cwd: '/repo',
    }, expect.objectContaining({
      timeoutMs: 15_000,
      maxStdoutBytes: 16_384,
      maxStderrBytes: 16_384,
    }));
    expect(cliPrint).not.toHaveBeenCalled();
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(checkReadiness).not.toHaveBeenCalled();
  });

  it('wires the default cliPrint session branch to transcript evidence and conversation discovery', async () => {
    const base = createPluginContextV1Fixture().ctx;
    const homeDir = await mkdtemp(join(tmpdir(), 'antigravity-cliprint-home-'));
    const transcriptDir = join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'brain',
      'conv-new',
      '.system_generated',
      'logs',
    );
    const run = vi.fn(async () => {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        join(transcriptDir, 'transcript_full.jsonl'),
        `${JSON.stringify({ type: 'assistant_message', id: 'assistant-1', text: 'from transcript' })}\n`,
      );
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
      };
    });
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        exec: {
          ...base.agentRuntime.exec,
          run,
        },
      },
    } as PluginContextV1;
    const engine = createAntigravityBackendEngine(ctx, {
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      env: { HOME: homeDir },
      metadata: { antigravityRuntimeMode: 'cliPrint' },
    });
    const events: unknown[] = [];
    runtime?.events.subscribe((event) => events.push(event));

    await expect(runtime?.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-1',
      agentTurnId: 'conv-new',
    });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'transcript-agent-message-committed',
      agentId: 'antigravity',
      localId: 'assistant-1',
      body: { type: 'message', message: 'from transcript' },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'descriptor-update',
      descriptor: expect.objectContaining({
        agentId: 'antigravity',
        agent: expect.objectContaining({
          runtimeMode: 'cliPrint',
          agyConversationId: 'conv-new',
        }),
      }),
    }));
    expect(runtime?.identity.read()).toEqual({ providerSessionId: 'conv-new' });
  });

  it('disambiguates concurrent new cliPrint conversations by matching the user prompt in transcript evidence', async () => {
    const base = createPluginContextV1Fixture().ctx;
    const homeDir = await mkdtemp(join(tmpdir(), 'antigravity-cliprint-home-'));
    const targetTranscriptDir = join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'brain',
      'conv-target',
      '.system_generated',
      'logs',
    );
    const unrelatedTranscriptDir = join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'brain',
      'conv-unrelated',
      '.system_generated',
      'logs',
    );
    const run = vi.fn(async () => {
      await mkdir(targetTranscriptDir, { recursive: true });
      await mkdir(unrelatedTranscriptDir, { recursive: true });
      await writeFile(
        join(targetTranscriptDir, 'transcript_full.jsonl'),
        [
          JSON.stringify({ type: 'user_input', id: 'user-target', text: 'hello target' }),
          JSON.stringify({ type: 'assistant_message', id: 'assistant-target', text: 'target response' }),
          '',
        ].join('\n'),
      );
      await writeFile(
        join(unrelatedTranscriptDir, 'transcript_full.jsonl'),
        [
          JSON.stringify({ type: 'user_input', id: 'user-other', text: 'other prompt' }),
          JSON.stringify({ type: 'assistant_message', id: 'assistant-other', text: 'other response' }),
          '',
        ].join('\n'),
      );
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
      };
    });
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        exec: {
          ...base.agentRuntime.exec,
          run,
        },
      },
    } as PluginContextV1;
    const engine = createAntigravityBackendEngine(ctx, {
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      env: { HOME: homeDir },
      metadata: { antigravityRuntimeMode: 'cliPrint' },
    });

    await expect(runtime?.send({ v: 1, text: 'hello target' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-1',
      agentTurnId: 'conv-target',
    });
    expect(runtime?.identity.read()).toEqual({ providerSessionId: 'conv-target' });
  });

  it('fails the default cliPrint session branch when transcript evidence contains only an error', async () => {
    const base = createPluginContextV1Fixture().ctx;
    const homeDir = await mkdtemp(join(tmpdir(), 'antigravity-cliprint-home-'));
    const transcriptDir = join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'brain',
      'conv-new',
      '.system_generated',
      'logs',
    );
    const run = vi.fn(async () => {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        join(transcriptDir, 'transcript_full.jsonl'),
        `${JSON.stringify({ type: 'error', id: 'error-1', message: 'agy failed from transcript' })}\n`,
      );
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
      };
    });
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        exec: {
          ...base.agentRuntime.exec,
          run,
        },
      },
    } as PluginContextV1;
    const engine = createAntigravityBackendEngine(ctx, {
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });
    const runtime = await engine.runtimeCore?.createSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
      env: { HOME: homeDir },
      metadata: { antigravityRuntimeMode: 'cliPrint' },
    });
    const events: unknown[] = [];
    runtime?.events.subscribe((event) => events.push(event));

    await expect(runtime?.send({ v: 1, text: 'hello' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
      turnId: 'turn-1',
    });

    expect(events
      .map((event) => (event as { kind?: string }).kind)
      .filter((kind) => kind === 'turn-failed' || kind === 'turn-complete'))
      .toEqual(['turn-failed']);
  });

  it('uses persisted descriptor mode ahead of provider settings for resumed sessions', async () => {
    const ctx = createFixtureContext();
    const sdkRuntime = createRuntime('sdk');
    const sdk = vi.fn(async () => sdkRuntime);
    const cliPrint = vi.fn(async () => createRuntime('cliPrint'));
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({
      metadata: {
        antigravityRuntimeMode: 'cliPrint',
        runtimeDescriptorV1: buildAntigravityRuntimeDescriptorV1({ runtimeMode: 'sdk' }),
      },
      accountSettings: {
        antigravityRuntimeMode: 'cliPrint',
      },
    } as CreateSessionRuntimeParamsV1)).resolves.toBe(sdkRuntime);
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(cliPrint).not.toHaveBeenCalled();
  });

  it('resolves auto to cliPrint when the boundary availability probe succeeds', async () => {
    const ctx = createFixtureContext();
    const cliRuntime = createRuntime('cliPrint');
    const sdk = vi.fn(async () => createRuntime('sdk'));
    const cliPrint = vi.fn(async () => cliRuntime);
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({ metadata: {} })).resolves.toBe(cliRuntime);
    expect(cliPrint).toHaveBeenCalledTimes(1);
    expect(sdk).not.toHaveBeenCalled();
  });

  it('resolves auto to sdk when cliPrint is unavailable but SDK credentials are available', async () => {
    const ctx = createFixtureContext();
    const sdkRuntime = createRuntime('sdk');
    const sdk = vi.fn(async () => sdkRuntime);
    const cliPrint = vi.fn(async () => createRuntime('cliPrint'));
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: { sdk, cliPrint },
      probes: {
        isCliPrintAvailable: vi.fn(async () => false),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({ metadata: {} })).resolves.toBe(sdkRuntime);
    expect(sdk).toHaveBeenCalledTimes(1);
    expect(cliPrint).not.toHaveBeenCalled();
  });

  it('surfaces setup diagnostics when auto cannot resolve a concrete runtime', async () => {
    const ctx = createFixtureContext();
    const engine = createAntigravityBackendEngine(ctx, {
      sessionRuntimes: {
        sdk: vi.fn(async () => createRuntime('sdk')),
        cliPrint: vi.fn(async () => createRuntime('cliPrint')),
      },
      probes: {
        isCliPrintAvailable: vi.fn(async () => false),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });

    await expect(engine.runtimeCore?.createSessionRuntime({ metadata: {} })).rejects.toMatchObject({
      reasonCode: 'antigravity_runtime_unavailable',
    });
  });

  it('passes the resolved concrete mode into execution-run backend dispatch', () => {
    const ctx = createFixtureContext();
    const sdkExecutionRun = createExecutionRunBackend('sdk');
    const executionRuns = {
      sdk: vi.fn(() => sdkExecutionRun),
      cliPrint: vi.fn(() => createExecutionRunBackend('cliPrint')),
    };
    const engine = createAntigravityBackendEngine(ctx, {
      executionRuns,
      probes: {
        isCliPrintAvailable: vi.fn(async () => false),
        hasSdkCredentials: vi.fn(async () => true),
      },
    });
    const executionRunParams: CreateExecutionRunBackendParamsV1 = {
      accountSettings: { antigravityRuntimeMode: 'sdk' },
      cwd: '/repo',
    };

    expect(engine.runtimeCore?.createExecutionRunBackend(executionRunParams)).toBe(sdkExecutionRun);
    expect(executionRuns.sdk).toHaveBeenCalledWith({
      ctx,
      mode: 'sdk',
      executionRunParams,
    });
    expect(executionRuns.cliPrint).not.toHaveBeenCalled();
  });

  it('provides a real cliPrint execution-run host backend through the default runtime path', async () => {
    const base = createPluginContextV1Fixture().ctx;
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: 'execution response\n',
      stderr: '',
    }));
    const ctx = {
      ...base,
      agentRuntime: {
        ...base.agentRuntime,
        exec: {
          ...base.agentRuntime.exec,
          run,
        },
      },
    } as PluginContextV1;
    const engine = createAntigravityBackendEngine(ctx, {
      probes: {
        isCliPrintAvailable: vi.fn(async () => true),
        hasSdkCredentials: vi.fn(async () => false),
      },
    });

    const backend = engine.runtimeCore?.createExecutionRunBackend({
      accountSettings: { antigravityRuntimeMode: 'cliPrint' },
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept', GEMINI_API_KEY: 'sdk-secret' },
      runId: 'run-1',
    });
    expectHostExecutionRunBackend(backend);
    expect('run' in backend).toBe(false);
    expect(backend.sendSteerPrompt).toBeUndefined();
    await expect(backend.readResumeSupport()).resolves.toBe(true);
    const messages: unknown[] = [];
    backend.subscribeMessages((message) => messages.push(message));

    await expect(backend.provisionSession()).resolves.toEqual({
      sessionId: 'antigravity-cliprint-execution-run:run-1',
    });
    await expect(backend.sendPrompt(
      'antigravity-cliprint-execution-run:run-1',
      'hello from execution run',
    )).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledWith({
      kind: 'agent-cli',
      agentId: 'antigravity',
      args: expect.arrayContaining(['-p', 'hello from execution run', '--sandbox', '--add-dir', '/repo']),
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }, expect.objectContaining({
      timeoutMs: expect.any(Number),
    }));
    const args = run.mock.calls[0]?.[0]?.args ?? [];
    expect(args[args.indexOf('-p') + 1]).toBe('hello from execution run');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(messages.map((message) => (message as { kind?: string }).kind)).toContain('turn-complete');
  });
});
