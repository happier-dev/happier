import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from "../raw/index.js";
import { createReducer, reducer } from "./reducer.js";

function toolMessage(params: Readonly<{
  id: string;
  input: Record<string, unknown>;
  runtimeEventKind?: 'tool-progress' | 'tool-call';
  fullSnapshot?: boolean;
}>): NormalizedMessage {
  return {
    id: params.id,
    seq: params.id === 'progress' ? 0 : 1,
    localId: 'acp-call-v1:one-card',
    createdAt: params.id === 'progress' ? 1_000 : 1_100,
    role: 'agent',
    content: [{
      type: 'tool-call',
      id: 'call-1',
      name: 'Read',
      input: params.input,
      description: null,
      uuid: `uuid-${params.id}`,
      parentUUID: null,
    }],
    isSidechain: false,
    ...(params.runtimeEventKind
      ? { meta: {
          source: 'runtime',
          runtimeEventKind: params.runtimeEventKind,
          runtimeTurnId: 'turn-1',
          ...(params.fullSnapshot === false ? {} : { runtimeToolSnapshotV1: { v: 1, mode: 'full' } }),
        } }
      : {}),
  };
}

describe('reducer runtime tool snapshots', () => {
  it('replaces prior runtime progress input with the full terminal snapshot so explicit clears stay cleared', () => {
    const state = createReducer();
    reducer(state, [toolMessage({
      id: 'progress',
      runtimeEventKind: 'tool-progress',
      input: {
        path: 'README.md',
        locations: [{ path: 'README.md', line: 2 }],
        _acp: {
          title: 'Read README',
          kind: 'read',
          status: 'running',
          content: [{ type: 'text', text: 'reading' }],
          locations: [{ path: 'README.md', line: 2 }],
        },
      },
    })], null);

    const result = reducer(state, [toolMessage({
      id: 'terminal',
      runtimeEventKind: 'tool-call',
      input: {
        path: 'README.md',
        locations: [],
        _acp: {
          title: null,
          kind: null,
          status: 'completed',
          content: null,
          locations: null,
        },
      },
    })], null);

    const tool = result.messages.find((message) => message.kind === 'tool-call');
    expect(tool?.seq).toBe(1);
    expect(tool?.tool.state).toBe('completed');
    expect(tool?.tool.completedAt).toBe(1_100);
    expect(tool?.tool.result).toBeUndefined();
    expect(tool?.tool.input).toEqual({
      path: 'README.md',
      locations: [],
      _acp: {
        title: null,
        kind: null,
        status: 'completed',
        content: null,
        locations: null,
      },
    });
  });

  it('settles a result-less cancelled runtime call without fabricating a tool result', () => {
    const state = createReducer();
    const result = reducer(state, [toolMessage({
      id: 'terminal',
      runtimeEventKind: 'tool-call',
      input: { _acp: { status: 'cancelled' } },
    })], null);

    const tool = result.messages.find((message) => message.kind === 'tool-call');
    expect(tool?.tool.state).toBe('error');
    expect(tool?.tool.completedAt).toBe(1_100);
    expect(tool?.tool.result).toBeUndefined();
  });

  it('retains legacy partial-update merge behavior when no runtime full-snapshot contract is present', () => {
    const state = createReducer();
    reducer(state, [toolMessage({
      id: 'progress',
      runtimeEventKind: 'tool-progress',
      fullSnapshot: false,
      input: {
        path: 'README.md',
        locations: [{ path: 'README.md', line: 2 }],
        _acp: { title: 'Read README', status: 'running' },
      },
    })], null);

    const result = reducer(state, [toolMessage({
      id: 'terminal',
      runtimeEventKind: 'tool-call',
      fullSnapshot: false,
      input: { _acp: { status: 'completed' } },
    })], null);

    const tool = result.messages.find((message) => message.kind === 'tool-call');
    expect(tool?.tool.input).toMatchObject({
      path: 'README.md',
      locations: [{ path: 'README.md', line: 2 }],
      _acp: { title: 'Read README', status: 'completed' },
    });
  });

  it('applies a later result to the same card promoted from runtime progress', () => {
    const state = createReducer();
    const progress = reducer(state, [toolMessage({
      id: 'progress',
      runtimeEventKind: 'tool-progress',
      input: { path: 'README.md', _acp: { status: 'running' } },
    })], null);
    const progressTool = progress.messages.find((message) => message.kind === 'tool-call');

    reducer(state, [toolMessage({
      id: 'terminal',
      runtimeEventKind: 'tool-call',
      input: { path: 'README.md', _acp: { status: 'completed' } },
    })], null);
    reducer(state, [{
      id: 'result',
      seq: 2,
      localId: 'acp-result-v1:one-result',
      createdAt: 1_200,
      role: 'agent',
      content: [{
        type: 'tool-result',
        tool_use_id: 'call-1',
        content: { text: 'done' },
        is_error: false,
        uuid: 'uuid-result',
        parentUUID: null,
      }],
      isSidechain: false,
      meta: { source: 'runtime', runtimeEventKind: 'tool-result', runtimeTurnId: 'turn-1' },
    }], null);

    const completedId = state.toolIdToMessageId.get('call-1');
    const completedTool = completedId ? state.messages.get(completedId) : undefined;
    expect(completedId).toBe(progressTool?.id);
    expect(completedTool?.tool).toBeTruthy();
    if (!completedTool?.tool) throw new Error('expected promoted tool card');
    expect(completedTool.tool.state).toBe('completed');
    expect(completedTool.tool.result).toEqual({ text: 'done' });
    expect(state.toolIdToMessageId.size).toBe(1);

    reducer(state, [{
      id: 'result-revision',
      seq: 2,
      localId: 'acp-result-v1:one-result',
      createdAt: 1_300,
      role: 'agent',
      content: [{
        type: 'tool-result',
        tool_use_id: 'call-1',
        content: { text: 'final', exitCode: 1 },
        is_error: true,
        uuid: 'uuid-result-revision',
        parentUUID: null,
      }],
      isSidechain: false,
      meta: { source: 'runtime', runtimeEventKind: 'tool-result', runtimeTurnId: 'turn-1' },
    }], null);

    expect(completedTool.tool.state).toBe('error');
    expect(completedTool.tool.result).toEqual({ text: 'final', exitCode: 1 });
    expect(completedTool.tool.completedAt).toBe(1_300);
    expect(state.toolIdToMessageId.size).toBe(1);
  });

  it('replaces previously loaded output when the same completed result expires', () => {
    const state = createReducer();
    reducer(state, [toolMessage({ id: 'terminal', input: { command: 'example' } })], null);
    const result = {
      id: 'result', seq: 2, localId: 'result-local', createdAt: 1_200,
      role: 'agent', isSidechain: false,
      content: [{
        type: 'tool-result', tool_use_id: 'call-1', is_error: true,
        uuid: 'result-block', parentUUID: null, content: { stdout: 'fixture', exitCode: 1 },
      }],
      toolOutputAvailability: { status: 'available' },
    } as const;
    reducer(state, [{ ...result, content: [...result.content] }], null);
    const expired = {
      ...result,
      content: [{ ...result.content[0], content: { exitCode: 1 } }],
      toolOutputAvailability: { status: 'expired', days: 30 } as const,
    };
    const update = reducer(state, [expired], null);
    const card = update.messages.find(message => message.kind === 'tool-call');
    expect(card?.tool).toMatchObject({
      input: { command: 'example' }, state: 'error', completedAt: 1_200,
      toolOutputAvailability: { status: 'expired', days: 30 },
    });
    expect(card?.tool.result).toEqual({ exitCode: 1 });
    expect(reducer(state, [expired], null).messages).toEqual([]);

    const fresh = {
      ...result, id: 'fresh-result', seq: 3, localId: 'fresh-result-local', createdAt: 1_300,
      content: [{ ...result.content[0], uuid: 'fresh-result-block', content: { exitCode: 0 }, is_error: false }],
      meta: { source: 'runtime', runtimeEventKind: 'tool-result' },
    } satisfies NormalizedMessage;
    expect(reducer(state, [fresh], null).messages.find(message => message.kind === 'tool-call')?.tool)
      .toMatchObject({ state: 'completed', result: { exitCode: 0 }, toolOutputAvailability: { status: 'available' } });
    expect(reducer(state, [expired], null).messages).toEqual([]);

  });

  it('keeps the expired observation when a tool result page precedes its call', () => {
    const state = createReducer();
    const result = {
      id: 'result', seq: 2, localId: 'result-local', createdAt: 1_200,
      role: 'agent', isSidechain: false,
      content: [{
        type: 'tool-result', tool_use_id: 'call-1', is_error: false,
        uuid: 'result-block', parentUUID: null, content: { stdout: 'old body', exitCode: 0 },
      }],
      toolOutputAvailability: { status: 'available' },
    } satisfies NormalizedMessage;
    reducer(state, [result], null);
    reducer(state, [{
      ...result,
      content: [{ ...result.content[0], content: { exitCode: 0 } }],
      toolOutputAvailability: { status: 'expired', days: 30 },
    }], null);
    const card = reducer(state, [toolMessage({ id: 'terminal', input: { command: 'example' } })], null)
      .messages.find(message => message.kind === 'tool-call');
    expect(card?.tool).toMatchObject({ toolOutputAvailability: { status: 'expired', days: 30 }, state: 'completed' });
    expect(card?.tool.result).toEqual({ exitCode: 0 });
  });

  it('continues ignoring duplicate terminal results outside the explicit runtime revision contract', () => {
    const state = createReducer();
    reducer(state, [toolMessage({ id: 'terminal', input: { path: 'README.md' } })], null);

    const resultMessage = (id: string, content: string): NormalizedMessage => ({
      id,
      seq: id === 'first-result' ? 2 : 3,
      localId: null,
      createdAt: id === 'first-result' ? 1_200 : 1_300,
      role: 'agent',
      content: [{
        type: 'tool-result',
        tool_use_id: 'call-1',
        content,
        is_error: false,
        uuid: `uuid-${id}`,
        parentUUID: null,
      }],
      isSidechain: false,
    });

    reducer(state, [resultMessage('first-result', 'first')], null);
    reducer(state, [resultMessage('duplicate-result', 'duplicate')], null);

    const toolId = state.toolIdToMessageId.get('call-1');
    const tool = toolId ? state.messages.get(toolId)?.tool : null;
    expect(tool?.result).toBe('first');
    expect(tool?.completedAt).toBe(1_200);
  });
});
