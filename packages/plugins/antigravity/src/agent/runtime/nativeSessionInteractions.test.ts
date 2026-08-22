import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

const captured = vi.hoisted(() => ({
  runtimeDeps: undefined as undefined | {
    requestPermission(request: Readonly<{ requestId: string; toolName: string; input: unknown }>): Promise<unknown>;
    elicit(request: Readonly<{
      requestId: string;
      questions: readonly Readonly<{
        id?: string;
        prompt?: string;
        label?: string;
        choices?: readonly string[];
      }>[];
    }>): Promise<unknown>;
    resolveMcpServers(): Promise<readonly unknown[]>;
  },
}));

vi.mock('../localharness/runtime/sessionRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../localharness/runtime/sessionRuntime.js')>();
  return {
    ...actual,
    createAntigravityLocalharnessSessionRuntime: vi.fn((deps: typeof captured.runtimeDeps) => {
      captured.runtimeDeps = deps;
      return {
        send: vi.fn(),
        cancel: vi.fn(),
        watch: vi.fn(),
        dispose: vi.fn(),
      } as unknown as AgentSessionRuntime;
    }),
  };
});

import {
  createAntigravityNativeExecutionRunRuntime,
  createAntigravityNativeSessionRuntime,
} from './nativeSession.js';

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

describe('Antigravity native transient interactions', () => {
  beforeEach(() => {
    captured.runtimeDeps = undefined;
  });

  it('uses the strict confirmation request and approves only an approved result', async () => {
    const confirm = vi.fn(async () => ({
      requestId: 'confirmation-1',
      kind: 'confirmation' as const,
      status: 'approved' as const,
    }));
    const context = {
      signal: new AbortController().signal,
      services: {
        exec: {},
        interactions: {
          confirm,
          askQuestions: vi.fn(),
        },
      },
      session: { id: 'session-1', services: {} },
    } as unknown as AgentRuntimeContext;

    createAntigravityNativeSessionRuntime({ mode: 'sdk', request, context });
    const result = await captured.runtimeDeps?.requestPermission({
      requestId: 'permission-1',
      toolName: 'read_file',
      input: {},
    });

    expect(confirm).toHaveBeenCalledWith({
      kind: 'confirmation',
      title: 'Antigravity permission',
      message: 'Allow Antigravity to use read_file?',
    });
    expect(result).toEqual({ decision: 'approved' });
  });

  it('maps strict question answers to localharness and cancels every terminal outcome', async () => {
    const askQuestions = vi.fn()
      .mockResolvedValueOnce({
        requestId: 'questions-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          target: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: '1' },
          },
          note: { kind: 'text', value: 'ship it' },
        },
      })
      .mockResolvedValueOnce({
        requestId: 'questions-2',
        kind: 'questions',
        status: 'unavailable',
      });
    const context = {
      signal: new AbortController().signal,
      services: {
        exec: {},
        interactions: {
          confirm: vi.fn(),
          askQuestions,
        },
      },
      session: { id: 'session-1', services: {} },
    } as unknown as AgentRuntimeContext;

    createAntigravityNativeSessionRuntime({ mode: 'sdk', request, context });
    const answered = await captured.runtimeDeps?.elicit({
      requestId: 'provider-questions-1',
      questions: [
        { id: 'target', prompt: 'Where?', choices: ['first', 'second'] },
        { id: 'note', prompt: 'Anything else?' },
      ],
    });
    const unavailable = await captured.runtimeDeps?.elicit({
      requestId: 'provider-questions-2',
      questions: [{ id: 'note', prompt: 'Anything else?' }],
    });

    expect(askQuestions).toHaveBeenNthCalledWith(1, {
      kind: 'questions',
      title: 'Antigravity question',
      questions: [
        {
          id: 'target',
          prompt: 'Where?',
          type: 'singleChoice',
          choices: [
            { id: '0', label: 'first' },
            { id: '1', label: 'second' },
          ],
        },
        { id: 'note', prompt: 'Anything else?', type: 'text' },
      ],
    });
    expect(answered).toEqual({
      status: 'answered',
      answers: [
        { multipleChoiceAnswer: { selectedChoiceIndices: [1] } },
        { textAnswer: { answer: 'ship it' } },
      ],
    });
    expect(unavailable).toEqual({ status: 'cancelled' });
  });

  it('does not give a detached execution run MCP from the generic invocation bag', async () => {
    const genericMcp = {
      list: vi.fn(() => {
        throw new Error('generic MCP must not resolve native-session launch servers');
      }),
    };
    const context = {
      signal: new AbortController().signal,
      services: {
        exec: {},
        interactions: {
          confirm: vi.fn(),
          askQuestions: vi.fn(),
        },
        mcp: genericMcp,
      },
    } as unknown as AgentRuntimeContext;

    createAntigravityNativeExecutionRunRuntime({ mode: 'sdk', request, context });

    await expect(captured.runtimeDeps?.resolveMcpServers()).resolves.toEqual([]);
    expect(genericMcp.list).not.toHaveBeenCalled();
  });
});
