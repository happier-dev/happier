import { describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';

function buildStreamSegmentMeta(opts: { segmentKind: 'assistant' | 'thinking'; updatedAtMs: number }) {
  return {
    happierStreamSegmentV1: {
      v: 1,
      segmentKind: opts.segmentKind,
      segmentLocalId: `${opts.segmentKind}-segment-1`,
      segmentState: 'streaming',
      startedAtMs: 1_000,
      updatedAtMs: opts.updatedAtMs,
    },
  };
}

describe('reducer (stream segment snapshots)', () => {
  it('reads stream segment state for active and terminal snapshots', async () => {
    vi.resetModules();
    const { readStreamSegmentMetaV1 } = await import('./helpers/streamSegmentMeta');

    expect(readStreamSegmentMetaV1(buildStreamSegmentMeta({
      segmentKind: 'assistant',
      updatedAtMs: 1_000,
    }))).toMatchObject({
      segmentKind: 'assistant',
      segmentLocalId: 'assistant-segment-1',
      segmentState: 'streaming',
      updatedAtMs: 1_000,
    });

    expect(readStreamSegmentMetaV1({
      happierStreamSegmentV1: {
        v: 1,
        segmentKind: 'assistant',
        segmentLocalId: 'assistant-segment-1',
        segmentState: 'complete',
        updatedAtMs: 1_010,
      },
    })).toMatchObject({ segmentState: 'complete' });

    expect(readStreamSegmentMetaV1({
      happierStreamSegmentV1: {
        v: 1,
        segmentKind: 'assistant',
        segmentLocalId: 'assistant-segment-1',
        segmentState: 'unknown',
        updatedAtMs: 1_020,
      },
    })).toMatchObject({ segmentState: null });
  });

  it('upserts assistant stream segments by localId and replaces snapshot text', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const first: NormalizedMessage = {
      id: 'm1',
      seq: 1,
      localId: 'local-1',
      createdAt: 1_000,
      role: 'agent',
      content: [{ type: 'text', text: 'Hello', uuid: 'u1', parentUUID: null }],
      isSidechain: false,
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 1_000 }) as any,
    };

    const res1 = reducer(state, [first], null);
    expect(res1.messages).toHaveLength(1);
    const m1 = res1.messages[0] as any;
    expect(m1.kind).toBe('agent-text');
    expect(m1.text).toBe('Hello');
    expect(m1.localId).toBe('assistant-segment-1');

    const second: NormalizedMessage = {
      ...first,
      createdAt: 1_000,
      content: [{ type: 'text', text: 'Hello world', uuid: 'u1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 2_000 }) as any,
    };

    const res2 = reducer(state, [second], null);
    expect(res2.messages).toHaveLength(1);
    const m2 = res2.messages[0] as any;
    expect(m2.id).toBe(m1.id);
    expect(m2.text).toBe('Hello world');
    expect(m2.localId).toBe('assistant-segment-1');
  });

  it('upserts assistant stream segments by segmentLocalId when durable snapshots were written with different localIds', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const first: NormalizedMessage = {
      id: 'm1',
      seq: 1,
      localId: 'commit-1',
      createdAt: 1_000,
      role: 'agent',
      content: [{ type: 'text', text: 'The', uuid: 'u1', parentUUID: null }],
      isSidechain: false,
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 1_000 }) as any,
    };

    const res1 = reducer(state, [first], null);
    expect(res1.messages).toHaveLength(1);
    const m1 = res1.messages[0] as any;
    expect(m1.text).toBe('The');

    const second: NormalizedMessage = {
      ...first,
      id: 'm2',
      seq: 2,
      localId: 'commit-2',
      content: [{ type: 'text', text: 'The full sentence', uuid: 'u1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 2_000 }) as any,
    };

    const res2 = reducer(state, [second], null);
    expect(res2.messages).toHaveLength(1);
    const m2 = res2.messages[0] as any;
    expect(m2.id).toBe(m1.id);
    expect(m2.text).toBe('The full sentence');
  });

  it('ignores out-of-order assistant stream segment snapshots by updatedAtMs', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const first: NormalizedMessage = {
      id: 'm1',
      seq: 1,
      localId: 'local-1',
      createdAt: 1_000,
      role: 'agent',
      content: [{ type: 'text', text: 'Hello', uuid: 'u1', parentUUID: null }],
      isSidechain: false,
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 2_000 }) as any,
    };

    const res1 = reducer(state, [first], null);
    expect(res1.messages).toHaveLength(1);
    const m1 = res1.messages[0] as any;
    expect(m1.text).toBe('Hello');
    const internalId = m1.id as string;

    const outOfOrder: NormalizedMessage = {
      ...first,
      seq: 0,
      content: [{ type: 'text', text: 'OLD', uuid: 'u1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 1_000 }) as any,
    };

    const res2 = reducer(state, [outOfOrder], null);
    expect(res2.messages).toHaveLength(0);
    const stored = state.messages.get(internalId) as any;
    expect(stored.text).toBe('Hello');
  });

  it('upserts thinking stream segments by localId and replaces snapshot text', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const first: NormalizedMessage = {
      id: 'm-thinking-1',
      seq: 1,
      localId: 'local-thinking-1',
      createdAt: 1_000,
      role: 'agent',
      content: [{ type: 'thinking', thinking: 'Hello', uuid: 'u-thinking-1', parentUUID: null }],
      isSidechain: false,
      meta: buildStreamSegmentMeta({ segmentKind: 'thinking', updatedAtMs: 1_000 }) as any,
    };

    const res1 = reducer(state, [first], null);
    expect(res1.messages).toHaveLength(1);
    const m1 = res1.messages[0] as any;
    expect(m1.kind).toBe('agent-text');
    expect(m1.isThinking).toBe(true);
    expect(m1.text).toBe('Hello');
    expect(m1.localId).toBe('thinking-segment-1');

    const second: NormalizedMessage = {
      ...first,
      content: [{ type: 'thinking', thinking: 'Hello world', uuid: 'u-thinking-1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'thinking', updatedAtMs: 2_000 }) as any,
    };

    const res2 = reducer(state, [second], null);
    expect(res2.messages).toHaveLength(1);
    const m2 = res2.messages[0] as any;
    expect(m2.id).toBe(m1.id);
    expect(m2.isThinking).toBe(true);
    expect(m2.text).toBe('Hello world');
    expect(m2.localId).toBe('thinking-segment-1');
  });

  it('ignores out-of-order thinking stream segment snapshots by updatedAtMs', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const first: NormalizedMessage = {
      id: 'm-thinking-1',
      seq: 1,
      localId: 'local-thinking-1',
      createdAt: 1_000,
      role: 'agent',
      content: [{ type: 'thinking', thinking: 'Hello', uuid: 'u-thinking-1', parentUUID: null }],
      isSidechain: false,
      meta: buildStreamSegmentMeta({ segmentKind: 'thinking', updatedAtMs: 2_000 }) as any,
    };

    const res1 = reducer(state, [first], null);
    expect(res1.messages).toHaveLength(1);
    const m1 = res1.messages[0] as any;
    expect(m1.text).toBe('Hello');
    const internalId = m1.id as string;

    const outOfOrder: NormalizedMessage = {
      ...first,
      seq: 0,
      content: [{ type: 'thinking', thinking: 'OLD', uuid: 'u-thinking-1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'thinking', updatedAtMs: 1_000 }) as any,
    };

    const res2 = reducer(state, [outOfOrder], null);
    expect(res2.messages).toHaveLength(0);
    const stored = state.messages.get(internalId) as any;
    expect(stored.text).toBe('Hello');
  });

  it('upserts sidechain assistant stream segments by localId and replaces snapshot text', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const toolCall: NormalizedMessage = {
      id: 'tool-parent-1',
      seq: 1,
      localId: null,
      createdAt: 1_000,
      role: 'agent',
      content: [
        {
          type: 'tool-call',
          id: 'tool-1',
          name: 'Task',
          input: { prompt: 'do it' },
          description: null,
          uuid: 'u-tool-1',
          parentUUID: null,
        },
      ],
      isSidechain: false,
      meta: undefined,
    };

    const sidechainFirst: NormalizedMessage = {
      id: 'sidechain-msg-1',
      seq: 2,
      localId: 'local-sidechain-1',
      createdAt: 1_100,
      role: 'agent',
      content: [{ type: 'text', text: 'Side hello', uuid: 'u-sidechain-1', parentUUID: null }],
      isSidechain: true,
      sidechainId: 'tool-1',
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 1_100 }) as any,
    };

    const res1 = reducer(state, [toolCall, sidechainFirst], null);
    const tool1 = res1.messages.find((m) => m.kind === 'tool-call') as any;
    expect(tool1).toBeTruthy();
    expect(tool1.children).toHaveLength(1);
    expect(tool1.children[0].kind).toBe('agent-text');
    expect(tool1.children[0].text).toBe('Side hello');
    expect(tool1.children[0].localId).toBe('assistant-segment-1');

    const sidechainSecond: NormalizedMessage = {
      ...sidechainFirst,
      content: [{ type: 'text', text: 'Side hello world', uuid: 'u-sidechain-1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 2_000 }) as any,
    };

    const res2 = reducer(state, [sidechainSecond], null);
    const tool2 = res2.messages.find((m) => m.kind === 'tool-call') as any;
    expect(tool2).toBeTruthy();
    expect(tool2.children).toHaveLength(1);
    expect(tool2.children[0].id).toBe(tool1.children[0].id);
    expect(tool2.children[0].text).toBe('Side hello world');
    expect(tool2.children[0].localId).toBe('assistant-segment-1');
  });

  it('ignores out-of-order sidechain assistant stream segment snapshots by updatedAtMs', async () => {
    vi.resetModules();
    vi.unmock('./helpers/streamSegmentMeta');
    const { createReducer, reducer } = await import('./reducer');
    const state = createReducer();

    const toolCall: NormalizedMessage = {
      id: 'tool-parent-1',
      seq: 1,
      localId: null,
      createdAt: 1_000,
      role: 'agent',
      content: [
        {
          type: 'tool-call',
          id: 'tool-1',
          name: 'Task',
          input: { prompt: 'do it' },
          description: null,
          uuid: 'u-tool-1',
          parentUUID: null,
        },
      ],
      isSidechain: false,
      meta: undefined,
    };

    const sidechainFirst: NormalizedMessage = {
      id: 'sidechain-msg-1',
      seq: 2,
      localId: 'local-sidechain-1',
      createdAt: 1_100,
      role: 'agent',
      content: [{ type: 'text', text: 'Side hello', uuid: 'u-sidechain-1', parentUUID: null }],
      isSidechain: true,
      sidechainId: 'tool-1',
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 2_000 }) as any,
    };

    const res1 = reducer(state, [toolCall, sidechainFirst], null);
    const tool1 = res1.messages.find((m) => m.kind === 'tool-call') as any;
    expect(tool1).toBeTruthy();
    expect(tool1.children).toHaveLength(1);
    expect(tool1.children[0].text).toBe('Side hello');

    const sidechainOutOfOrder: NormalizedMessage = {
      ...sidechainFirst,
      seq: 0,
      content: [{ type: 'text', text: 'OLD', uuid: 'u-sidechain-1', parentUUID: null }],
      meta: buildStreamSegmentMeta({ segmentKind: 'assistant', updatedAtMs: 1_000 }) as any,
    };

    const res2 = reducer(state, [sidechainOutOfOrder], null);
    const tool2 = res2.messages.find((m) => m.kind === 'tool-call') as any;
    expect(tool2).toBeTruthy();
    expect(tool2.children).toHaveLength(1);
    expect(tool2.children[0].id).toBe(tool1.children[0].id);
    expect(tool2.children[0].text).toBe('Side hello');
  });
});
