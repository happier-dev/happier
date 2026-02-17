import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('sidechains (provider-agnostic)', () => {
  it('merges streaming sidechain text chunks when happierSidechainStreamKey is shared', () => {
    const state = createReducer();

    const runTool: NormalizedMessage = {
      id: 'msg_run',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'subagent_run_1',
          name: 'SubAgentRun',
          input: { intent: 'review' },
          description: null,
          uuid: 'uuid_run',
          parentUUID: null,
        },
      ],
    };

    const streamKey = 'sc_stream_key_1';

    const sidechainChunk1: NormalizedMessage = {
      id: 'msg_sc_chunk_1',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      meta: { happierSidechainStreamKey: streamKey },
      content: [
        {
          type: 'text',
          text: 'Working',
          uuid: 'uuid_sc_chunk_1',
          parentUUID: null,
        },
      ],
    } as any;
    (sidechainChunk1 as any).sidechainId = 'subagent_run_1';

    const sidechainChunk2: NormalizedMessage = {
      id: 'msg_sc_chunk_2',
      localId: null,
      createdAt: 1300,
      role: 'agent',
      isSidechain: true,
      meta: { happierSidechainStreamKey: streamKey },
      content: [
        {
          type: 'text',
          text: '...done',
          uuid: 'uuid_sc_chunk_2',
          parentUUID: null,
        },
      ],
    } as any;
    (sidechainChunk2 as any).sidechainId = 'subagent_run_1';

    const result = reducer(state, [runTool, sidechainChunk1, sidechainChunk2]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgentRun') as any;
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.children).toHaveLength(1);

    const merged = toolMessage.children[0];
    expect(merged.kind).toBe('agent-text');
    expect(merged.text).toBe('Working...done');
  });

  it('attaches sidechain thread to Task tool-call via tool-call id sidechainId', () => {
    const state = createReducer();

    const taskTool: NormalizedMessage = {
      id: 'msg_task',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_task_1',
          name: 'Task',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_task',
          parentUUID: null,
        },
      ],
    };

    const sidechainRoot: NormalizedMessage = {
      id: 'msg_sc_root',
      localId: null,
      createdAt: 1100,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'sidechain',
          uuid: 'uuid_sc_root',
          prompt: 'Search for files',
        },
      ],
    } as any;
    (sidechainRoot as any).sidechainId = 'tool_task_1';

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'text',
          text: 'Working...',
          uuid: 'uuid_sc_text',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainText as any).sidechainId = 'tool_task_1';

    // Process all at once.
    const result = reducer(state, [taskTool, sidechainRoot, sidechainText]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'Task') as any;
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.children).toHaveLength(2);
    expect(toolMessage.children[0].kind).toBe('user-text');
    expect(toolMessage.children[1].kind).toBe('agent-text');
  });

  it('attaches sidechain thread to SubAgentRun tool-call via tool-call id sidechainId', () => {
    const state = createReducer();

    const runTool: NormalizedMessage = {
      id: 'msg_run',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'subagent_run_1',
          name: 'SubAgentRun',
          input: { intent: 'review' },
          description: null,
          uuid: 'uuid_run',
          parentUUID: null,
        },
      ],
    };

    const sidechainRoot: NormalizedMessage = {
      id: 'msg_sc_root',
      localId: null,
      createdAt: 1100,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'sidechain',
          uuid: 'uuid_sc_root',
          prompt: 'Reviewing...',
        },
      ],
    } as any;
    (sidechainRoot as any).sidechainId = 'subagent_run_1';

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'text',
          text: 'Working...',
          uuid: 'uuid_sc_text',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainText as any).sidechainId = 'subagent_run_1';

    const result = reducer(state, [runTool, sidechainRoot, sidechainText]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgentRun') as any;
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.children).toHaveLength(2);
    expect(toolMessage.children[0].kind).toBe('user-text');
    expect(toolMessage.children[1].kind).toBe('agent-text');
  });

  it('falls back to reducer message id when tool-call id is empty', () => {
    const state = createReducer();

    const taskTool: NormalizedMessage = {
      id: 'msg_task',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: '',
          name: 'Task',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_task',
          parentUUID: null,
        },
      ],
    };

    const sidechainRoot: NormalizedMessage = {
      id: 'msg_sc_root',
      localId: null,
      createdAt: 1100,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'sidechain',
          uuid: 'uuid_sc_root',
          prompt: 'Search for files',
        },
      ],
    } as any;
    (sidechainRoot as any).sidechainId = 'msg_task';

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'text',
          text: 'Working...',
          uuid: 'uuid_sc_text',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainText as any).sidechainId = 'msg_task';

    const result = reducer(state, [taskTool, sidechainRoot, sidechainText]);
    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'Task') as any;
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.children).toHaveLength(2);
    expect(toolMessage.children[0].kind).toBe('user-text');
    expect(toolMessage.children[1].kind).toBe('agent-text');
  });

  it('does not emit sidechain child tool messages as root transcript messages when sidechain tool results arrive', () => {
    const state = createReducer();

    const taskTool: NormalizedMessage = {
      id: 'msg_task',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_task_1',
          name: 'Task',
          input: { prompt: 'Search for files', run_in_background: true },
          description: null,
          uuid: 'uuid_task',
          parentUUID: null,
        },
      ],
    };

    const sidechainRoot: NormalizedMessage = {
      id: 'msg_sc_root',
      localId: null,
      createdAt: 1100,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'sidechain',
          uuid: 'uuid_sc_root',
          prompt: 'Search for files',
        },
      ],
    } as any;
    (sidechainRoot as any).sidechainId = 'tool_task_1';

    const sidechainToolCall: NormalizedMessage = {
      id: 'msg_sc_tool_call',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'tool-call',
          id: 'tool_bash_1',
          name: 'Bash',
          input: { command: 'ls' },
          description: 'List files',
          uuid: 'uuid_sc_tool_call',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainToolCall as any).sidechainId = 'tool_task_1';

    // First pass: attach sidechain and create sidechain tool-call child.
    const result1 = reducer(state, [taskTool, sidechainRoot, sidechainToolCall]);
    const rootToolCalls1 = result1.messages.filter((m) => m.kind === 'tool-call');
    expect(rootToolCalls1.map((m: any) => m.tool?.name)).toEqual(['Task']);

    // Second pass: sidechain tool_result updates the Bash tool. This should not surface as a root tool-call.
    const sidechainToolResult: NormalizedMessage = {
      id: 'msg_sc_tool_result',
      localId: null,
      createdAt: 1300,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'tool-result',
          tool_use_id: 'tool_bash_1',
          content: 'ok',
          is_error: false,
          uuid: 'uuid_sc_tool_result',
          parentUUID: 'uuid_sc_tool_call',
        },
      ],
    } as any;
    (sidechainToolResult as any).sidechainId = 'tool_task_1';

    const result2 = reducer(state, [sidechainToolResult]);
    const rootToolCalls2 = result2.messages.filter((m) => m.kind === 'tool-call');
    expect(rootToolCalls2.map((m: any) => m.tool?.name)).toEqual(['Task']);
  });

  it('does not emit sidechain child thinking merges as root transcript messages', () => {
    const state = createReducer();

    const taskTool: NormalizedMessage = {
      id: 'msg_task',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_task_1',
          name: 'Task',
          input: { prompt: 'Search for files', run_in_background: true },
          description: null,
          uuid: 'uuid_task',
          parentUUID: null,
        },
      ],
    };

    const sidechainRoot: NormalizedMessage = {
      id: 'msg_sc_root',
      localId: null,
      createdAt: 1100,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'sidechain',
          uuid: 'uuid_sc_root',
          prompt: 'Search for files',
        },
      ],
    } as any;
    (sidechainRoot as any).sidechainId = 'tool_task_1';

    const sidechainThinking1: NormalizedMessage = {
      id: 'msg_sc_thinking_1',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'thinking',
          thinking: 'a',
          uuid: 'uuid_sc_thinking_1',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainThinking1 as any).sidechainId = 'tool_task_1';

    // First pass creates the sidechain thinking message.
    const result1 = reducer(state, [taskTool, sidechainRoot, sidechainThinking1]);
    const rootKinds1 = result1.messages.map((m) => m.kind);
    expect(rootKinds1).toContain('tool-call');
    expect(rootKinds1).not.toContain('agent-text');

    const sidechainThinking2: NormalizedMessage = {
      id: 'msg_sc_thinking_2',
      localId: null,
      createdAt: 1300,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'thinking',
          thinking: 'b',
          uuid: 'uuid_sc_thinking_2',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainThinking2 as any).sidechainId = 'tool_task_1';

    // Second pass merges the thinking chunk into the existing sidechain thinking message.
    // This must not surface the sidechain thinking message as a root transcript message.
    const result2 = reducer(state, [sidechainThinking2]);
    const rootKinds2 = result2.messages.map((m) => m.kind);
    expect(rootKinds2).toContain('tool-call');
    expect(rootKinds2).not.toContain('agent-text');
  });
});
