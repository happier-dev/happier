import { describe, it, expect } from 'vitest';
import { createReducer, projectSidechainMessages, reducer } from './reducer.js';
import type { NormalizedMessage } from '../raw/index.js';

function call(id: string, sidechainId?: string): NormalizedMessage {
  return {
    id: `call_${id}`, localId: null, createdAt: 1000, role: 'agent',
    isSidechain: Boolean(sidechainId), sidechainId,
    content: [{ type: 'tool-call', id, name: 'SubAgentRun', input: { runId: id }, description: null, uuid: id, parentUUID: null }],
  };
}

describe('sidechain published snapshots', () => {
  it('publishes late media for a completed nested tool without republishing equal metadata', () => {
      const state = createReducer();
      const calls: NormalizedMessage[] = ['outer', 'read'].map(id => ({
          id: `call-${id}`, localId: null, createdAt: 1, role: 'agent',
          isSidechain: id === 'read', sidechainId: id === 'read' ? 'outer' : undefined,
          content: [{
              type: 'tool-call', id, name: id === 'outer' ? 'Task' : 'Read', input: {},
              description: null, uuid: `call-${id}`, parentUUID: null,
          }],
      }));
      const result: NormalizedMessage = {
          id: 'result', localId: null, createdAt: 2, role: 'agent', isSidechain: false,
          content: [{
              type: 'tool-result', tool_use_id: 'read', content: 'Read finished',
              is_error: false, uuid: 'result', parentUUID: null,
          }],
      };
      const completed = reducer(state, [...calls, result]);
      const root = completed.messages.find(message => message.kind === 'tool-call' && message.tool.id === 'outer');
      if (!root || root.kind !== 'tool-call') throw new Error('Expected outer Task');
      expect(root.children[0]).toMatchObject({ tool: { state: 'completed', result: 'Read finished', completedAt: 2 } });
      expect(root.children[0]?.meta?.happier).toBeUndefined();

      const meta = { happier: { kind: 'session_media.v1', payload: {
          media: [{
              id: 'late-image', role: 'output', category: 'tool-artifact', mediaKind: 'image',
              name: 'comparison.png', path: '.happier/uploads/artifacts/comparison.png',
              mimeType: 'image/png', sizeBytes: 80,
              origin: { source: 'tool-output', toolCallId: 'read' },
          }],
      } } };
      const lateResult: NormalizedMessage = { ...result, id: 'late-result', createdAt: 3, meta };
      const updated = reducer(state, [lateResult]);
      const nextRoot = updated.messages.find(message => message.id === root.id);
      expect(nextRoot).toMatchObject({
          children: [{ tool: { state: 'completed', result: 'Read finished', completedAt: 2 }, meta }],
      });
      if (!nextRoot || nextRoot.kind !== 'tool-call') throw new Error('Expected updated outer Task');
      expect(root.children[0]?.meta?.happier).toBeUndefined();
      expect(updated.messages).toHaveLength(1);

      const replayMeta = JSON.parse(JSON.stringify({
          happier: { payload: meta.happier.payload, kind: meta.happier.kind },
      }));
      const replay = reducer(state, [{ ...lateResult, id: 'late-result-replay', meta: replayMeta }]);
      expect(replay.messages).toEqual([]);
      const read = [...state.messages.values()].find(message => message.tool?.id === 'read');
      expect(read?.meta).toBe(nextRoot.children[0]?.meta);
  });

  it('keeps ancestor suppression correct across different cyclic projection roots', () => {
    const state = createReducer();
    const nestedA = { ...call('a', 'b'), id: 'nested_a' };
    const initial = reducer(state, [call('a'), call('b', 'a'), nestedA]);
    const root = initial.messages.find(row => row.kind === 'tool-call' && row.realID === 'call_a');
    expect(root).toMatchObject({ children: [{ tool: { id: 'b' }, children: [{ tool: { id: 'a' }, children: [] }] }] });
    expect(projectSidechainMessages(state, 'b')).toMatchObject([
      { tool: { id: 'a' }, children: [{ tool: { id: 'b' }, children: [] }] },
    ]);
    expect(projectSidechainMessages(state, 'a')).toMatchObject([
      { tool: { id: 'b' }, children: [{ tool: { id: 'a' }, children: [] }] },
    ]);
    expect(root).toMatchObject({ children: [{ children: [{ children: [] }] }] });
  });

  it('publishes nested observation changes through the metadata-only entry and retains the sibling', () => {
    const state = createReducer();
    const first = reducer(state, [call('outer'), call('inner', 'outer'), call('leaf', 'inner'), call('sibling', 'outer')]).messages[0];
    if (first.kind !== 'tool-call') throw new Error('Expected root');
    const updated = reducer(state, [], null, [{ id: 'call_leaf', localId: null, sourceUpdatedAt: 3000 }]);
    const next = updated.messages.find(row => row.id === first.id);
    expect(next).toMatchObject({ children: [{ children: [{ sourceUpdatedAt: 3000 }] }, {}] });
    if (!next || next.kind !== 'tool-call') throw new Error('Expected updated root');
    expect(next.children[1]).toBe(first.children[1]);
    const previousInner = first.children[0];
    if (previousInner.kind !== 'tool-call') throw new Error('Expected nested call');
    expect(previousInner.children[0].sourceUpdatedAt).toBeUndefined();
  });

  it('retains unchanged sibling snapshots through real arrivals and replaces only actual changes', () => {
    const state = createReducer();
    const first = reducer(state, [call('outer'), call('left', 'outer'), call('right', 'outer')]).messages[0];
    if (first.kind !== 'tool-call') throw new Error('Expected root');
    const [left, right] = first.children;
    expect(projectSidechainMessages(state, 'outer')[1]).toBe(right);
    const updated = reducer(state, [{
      id: 'left_result', localId: null, createdAt: 2000, role: 'agent', isSidechain: true, sidechainId: 'outer',
      content: [{ type: 'tool-result', tool_use_id: 'left', content: { status: 'succeeded' }, is_error: false, uuid: 'left_result', parentUUID: 'left' }],
    }]).messages.find(row => row.id === first.id);
    if (!updated || updated.kind !== 'tool-call') throw new Error('Expected updated root');
    expect(updated).not.toBe(first);
    expect(updated.children[0]).not.toBe(left);
    expect(updated.children[1]).toBe(right);
    expect(updated.tool).toBe(first.tool);
    expect(first.children[0]).toMatchObject({ tool: { state: 'running' } });
    expect(updated.children[0]).toMatchObject({ tool: { state: 'completed' } });
    expect(projectSidechainMessages(state, 'outer')[1]).toBe(right);
  });

  it('snapshots mutable permission decisions and keeps repeated projections stable', () => {
    const state = createReducer();
    const input = { command: 'true' };
    const first = reducer(state, [], { requests: { permission: { tool: 'Bash', arguments: input, createdAt: 1000 } } }).messages[0];
    if (first.kind !== 'tool-call') throw new Error('Expected permission');
    const next = reducer(state, [], { completedRequests: { permission: { tool: 'Bash', arguments: input, createdAt: 1000, completedAt: 2000, status: 'approved' } } }).messages.find(row => row.id === first.id);
    expect(first).toMatchObject({ tool: { permission: { status: 'pending' } } });
    expect(next).toMatchObject({ tool: { permission: { status: 'approved' } } });
    expect(next).not.toBe(first);
  });
  it.each([
    { withPermissionMirror: false, sidechainId: 'inner' },
    { withPermissionMirror: true, sidechainId: 'inner' },
    { withPermissionMirror: true, sidechainId: undefined },
  ])('publishes the root when a nested sidechain tool finishes (permission mirror: $withPermissionMirror, scope: $sidechainId)', ({ withPermissionMirror, sidechainId }) => {
    const state = createReducer();
    const input = { prompt: 'Review synthetic files' };
    if (withPermissionMirror) {
      reducer(state, [], { requests: { inner: { tool: 'Task', arguments: input, createdAt: 900 } } });
    }
    function call(id: string, sidechainId?: string): NormalizedMessage {
      return {
        id: `message_${id}`, localId: null, createdAt: 1000,
        role: 'agent', isSidechain: Boolean(sidechainId), sidechainId,
        content: [{ type: 'tool-call', id, name: 'Task', input, description: null, uuid: id, parentUUID: null }],
      };
    }
    const initial = reducer(state, [call('outer'), call('inner', 'outer'), call('leaf', 'inner')]);
    const root = initial.messages.find((message) => message.kind === 'tool-call' && message.tool.id === 'outer');
    if (!root || root.kind !== 'tool-call') throw new Error('Expected root Task');
    expect(root.children[0]).toMatchObject({ kind: 'tool-call', tool: { id: 'inner' }, children: [{ tool: { id: 'leaf', state: 'running' } }] });

    const result = { output: 'synthetic result' };
    const updated = reducer(state, [{
      id: 'leaf_result', localId: null, createdAt: 2000, role: 'agent', isSidechain: Boolean(sidechainId), sidechainId,
      content: [{ type: 'tool-result', tool_use_id: 'leaf', content: result, is_error: false, uuid: 'leaf_result', parentUUID: sidechainId ? 'leaf' : null }],
    }]);
    const nextRoot = updated.messages.find((message) => message.id === root.id);
    expect(nextRoot).toMatchObject({
      kind: 'tool-call', children: [{ tool: { id: 'inner' }, children: [{ tool: { id: 'leaf', state: 'completed', result } }] }],
    });
    if (!nextRoot || nextRoot.kind !== 'tool-call') throw new Error('Expected updated root Task');
    expect(nextRoot).not.toBe(root);
    expect(nextRoot.tool.input).toBe(root.tool.input);
    expect(root.children[0]).toMatchObject({ children: [{ tool: { state: 'running', result: undefined } }] });
    expect(updated.messages.filter((message) => message.kind === 'tool-call')).toHaveLength(1);
  });

  it('publishes nested text through its actual owner while preserving permission mirror results', () => {
    const state = createReducer();
    const input = { prompt: 'Review synthetic files' };
    reducer(state, [], { requests: { inner: { tool: 'Task', arguments: input, createdAt: 900 } } });
    const calls: NormalizedMessage[] = ['outer', 'inner'].map((id) => ({
      id: `message_${id}`, localId: null, createdAt: 1000, role: 'agent',
      isSidechain: id === 'inner', sidechainId: id === 'inner' ? 'outer' : undefined,
      content: [{ type: 'tool-call', id, name: 'Task', input, description: null, uuid: id, parentUUID: null }],
    }));
    const initial = reducer(state, calls);
    const root = initial.messages.find((message) => message.kind === 'tool-call' && message.tool.id === 'outer');
    if (!root || root.kind !== 'tool-call') throw new Error('Expected root Task');

    const updated = reducer(state, [{
      id: 'nested_text', localId: null, createdAt: 1500, role: 'agent', isSidechain: true, sidechainId: 'inner',
      content: [{ type: 'text', text: 'Working inside inner', uuid: 'nested_text', parentUUID: null }],
    }]);
    expect(updated.messages.find((message) => message.id === root.id)).toMatchObject({
      children: [{ tool: { id: 'inner' }, children: [{ kind: 'agent-text', text: 'Working inside inner' }] }],
    });
    expect(root.children[0]).toMatchObject({ children: [] });

    const completed = reducer(state, [{
      id: 'inner_result', localId: null, createdAt: 2000, role: 'agent', isSidechain: true, sidechainId: 'outer',
      content: [{ type: 'tool-result', tool_use_id: 'inner', content: 'done', is_error: false, permissions: { result: 'approved', date: 2000 }, uuid: 'inner_result', parentUUID: 'inner' }],
    }]);
    expect(completed.messages.find((message) => message.id === root.id)).toMatchObject({
      children: [{ tool: { id: 'inner', state: 'completed', result: 'done', permission: { status: 'approved' } } }],
    });
    expect(completed.messages.find((message) => message.id !== root.id)).toMatchObject({
      realID: null, tool: { id: 'inner', state: 'completed', result: 'done', permission: { status: 'approved' } },
    });
    expect(completed.messages).toHaveLength(2);
  });


});
