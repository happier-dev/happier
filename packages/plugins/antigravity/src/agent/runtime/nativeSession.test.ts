import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionOpenRequest,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

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

  it('carries an exact generic resume request into the Antigravity conversation argv', async () => {
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
        exec: { systemTools: { resolve }, run } as unknown as PluginExecService,
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

    const runtime = createAntigravityNativeSessionRuntime({ mode: 'cliPrint', request, context });
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
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('opens SDK mode through stable exec, bound-session MCP, and launch environment owners', async () => {
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
        confirm: vi.fn(async () => false),
        askQuestions: vi.fn(async () => ({ status: 'cancelled' as const })),
      },
      session: { id: 'session-1', services: { mcp: { resolveServers } } },
    } as unknown as AgentSessionRuntimeContext;
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/repo',
      launchEnvironment: {
        values: { GEMINI_API_KEY: 'gemini-key' },
        unset: [],
      },
      configuration: {
        mode: { value: 'sdk', updatedAtMs: 1 },
        model: { value: 'gemini-3.5-flash', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 },
        options: {},
      },
    };

    const runtime = createAntigravityNativeSessionRuntime({ mode: 'sdk', request, context });
    await expect(runtime.send({
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).resolves.toMatchObject({
      status: 'admitted',
    });

    expect(resolveServers).toHaveBeenCalledWith({ signal: context.signal });
    expect(spawn).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        models: [expect.objectContaining({
          name: 'gemini-3.5-flash',
          geminiApiEndpoint: { apiKey: 'gemini-key' },
        })],
        mcpServers: [{ name: 'docs', http: { url: 'https://example.test/mcp' } }],
      }),
    }));
    expect(sent[1]).toEqual({ userInput: 'hello' });
  });
});
