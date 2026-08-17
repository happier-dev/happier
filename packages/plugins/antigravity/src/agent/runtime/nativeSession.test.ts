import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionOpenRequest,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

import { createAntigravityNativeSessionRuntime } from './nativeSession.js';

describe('createAntigravityNativeSessionRuntime', () => {
  it('opens CLI print mode through the same provider session owner', () => {
    const context = {
      signal: new AbortController().signal,
      services: { exec: {} },
      ui: {},
      session: { id: 'session-1', services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/repo',
      launchEnvironment: { values: { SAFE_TEST_ENV: 'kept' }, unset: [] },
      configuration: {
        mode: { value: 'cliPrint', updatedAtMs: 1 },
        model: { value: 'gemini-3.5-flash', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: {},
      },
    };

    const runtime = createAntigravityNativeSessionRuntime({ mode: 'cliPrint', request, context });

    expect(runtime).toMatchObject({
      send: expect.any(Function),
      cancel: expect.any(Function),
      watch: expect.any(Function),
      dispose: expect.any(Function),
    });
    expect(runtime).not.toHaveProperty('identity');
    expect(runtime).not.toHaveProperty('events');
  });

  it.each([
    ['API key', {
      GEMINI_API_KEY: 'qualified-gemini-key',
      GOOGLE_API_KEY: 'qualified-gemini-key',
    }],
    ['Vertex', {
      GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_CLOUD_PROJECT: 'vertex-project',
      GOOGLE_CLOUD_LOCATION: 'europe-west1',
    }],
  ])('carries an exact generic resume request and qualified %s environment into the CLI spawn', async (_label, connectedAccountEnv) => {
    const resolve = vi.fn(async () => ({
      executable: { kind: 'systemTool' as const, id: 'antigravity-cli' },
      executablePath: '/usr/local/bin/agy',
    }));
    const run = vi.fn(async () => ({
      termination: {
        observed: { kind: 'exit' as const, exitCode: 0 },
        requestedBy: { kind: 'none' as const },
      },
      stdout: new TextEncoder().encode('continued response'),
      stderr: new TextEncoder().encode(''),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const context = {
      signal: new AbortController().signal,
      services: {
        exec: { systemTools: { resolve }, run } as unknown as ExecService,
      },
      ui: {},
      session: { id: 'session-1', services: {} },
    } as unknown as AgentSessionRuntimeContext;
    const request: AgentSessionOpenRequest = {
      kind: 'resume',
      sessionId: 'session-1',
      cwd: '/repo',
      providerSessionId: 'conversation-exact-1',
      configuration: {
        mode: { value: 'cliPrint', updatedAtMs: 1 },
        model: { value: 'gemini-3.5-flash', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: {},
      },
    };

    const runtime = createAntigravityNativeSessionRuntime({
      mode: 'cliPrint',
      request,
      context,
      connectedAccountEnv,
    });
    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'continue here' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toMatchObject({ status: 'admitted' });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'antigravity-cli' },
      args: [
        '-p',
        'continue here',
        '--model',
        'gemini-3.5-flash',
        '--sandbox',
        '--conversation',
        'conversation-exact-1',
        '--add-dir',
        '/repo',
      ],
      env: expect.objectContaining(connectedAccountEnv),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it.each([
    ['API key', {
      GEMINI_API_KEY: 'qualified-gemini-key',
    }, {
      geminiApiEndpoint: { apiKey: 'qualified-gemini-key' },
    }],
    ['Vertex', {
      GOOGLE_GENAI_USE_VERTEXAI: '1',
      GOOGLE_CLOUD_PROJECT: 'vertex-project',
      GOOGLE_CLOUD_LOCATION: 'europe-west1',
    }, {
      vertexEndpoint: {
        project: 'vertex-project',
        location: 'europe-west1',
      },
    }],
  ])('opens SDK mode with qualified %s auth through the real credential resolver', async (
    _label,
    materializedAuthEnv,
    expectedModelEndpoint,
  ) => {
    const sent: unknown[] = [];
    const spawn = vi.fn(async () => ({
      client: {
        send: vi.fn(async (message: unknown) => { sent.push(message); }),
        subscribe: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(async () => undefined),
      },
      process: {} as never,
      wait: vi.fn(() => new Promise(() => undefined)),
      dispose: vi.fn(async () => undefined),
    }));
    const resolveServers = vi.fn(async () => [{
      id: 'docs-id',
      name: 'docs',
      transport: { kind: 'http' as const, url: 'https://example.test/mcp' },
    }]);
    const context = {
      signal: new AbortController().signal,
      services: { exec: { clients: { spawn } } },
      ui: {
        confirm: vi.fn(async () => ({
          requestId: 'confirmation-declined',
          kind: 'confirmation' as const,
          status: 'declined' as const,
        })),
        askQuestions: vi.fn(async () => ({
          requestId: 'questions-cancelled',
          kind: 'questions' as const,
          status: 'userCancelled' as const,
        })),
      },
      session: { id: 'session-1', services: { mcp: { resolveServers } } },
    } as unknown as AgentSessionRuntimeContext;
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/repo',
      launchEnvironment: { values: {}, unset: [] },
      configuration: {
        mode: { value: 'sdk', updatedAtMs: 1 },
        model: { value: 'gemini-3.5-flash', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: {},
      },
    };

    const materializeAuthEnv = vi.fn(async () => materializedAuthEnv);
    const runtime = createAntigravityNativeSessionRuntime({
      mode: 'sdk',
      request,
      context,
      materializeAuthEnv,
    });
    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toMatchObject({
      status: 'admitted',
    });

    expect(resolveServers).toHaveBeenCalledWith({ signal: context.signal });
    expect(materializeAuthEnv).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        models: [expect.objectContaining({
          name: 'gemini-3.5-flash',
          ...expectedModelEndpoint,
        })],
        mcpServers: [{ name: 'docs', http: { url: 'https://example.test/mcp' } }],
      }),
    }));
    expect(sent[1]).toEqual({ userInput: 'hello' });
  });
});
