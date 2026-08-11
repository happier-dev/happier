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

  it('attaches sidechain thread to SubAgent tool-call via tool-call id sidechainId', () => {
    const state = createReducer();

    const subAgentTool: NormalizedMessage = {
      id: 'msg_subagent',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_subagent_1',
          name: 'SubAgent',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_subagent',
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
    (sidechainRoot as any).sidechainId = 'tool_subagent_1';

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'text',
          text: 'done',
          uuid: 'uuid_sc_text',
          parentUUID: 'uuid_sc_root',
        },
      ],
    };

    const result = reducer(state, [subAgentTool, sidechainRoot, sidechainText]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent') as any;
    expect(toolMessage).toBeTruthy();
    expect(toolMessage.children).toHaveLength(2);
    expect(toolMessage.children[0]?.kind).toBe('user-text');
    expect(toolMessage.children[1]?.kind).toBe('agent-text');
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

  it('keeps subagent tools running when a ready event follows sidechain activity', () => {
    const state = createReducer();

    const subAgentTool: NormalizedMessage = {
      id: 'msg_subagent',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_subagent_1',
          name: 'SubAgent',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_subagent',
          parentUUID: null,
        },
      ],
    };

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      sidechainId: 'tool_subagent_1',
      content: [
        {
          type: 'text',
          text: 'Still working',
          uuid: 'uuid_sc_text',
          parentUUID: null,
        },
      ],
    };

    const readyEvent: NormalizedMessage = {
      id: 'ready_1',
      localId: null,
      createdAt: 1500,
      role: 'event',
      isSidechain: false,
      content: { type: 'ready' },
    };

    const result = reducer(state, [subAgentTool, sidechainText, readyEvent]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent');
    if (!toolMessage || toolMessage.kind !== 'tool-call') throw new Error('Expected SubAgent tool message');
    expect(toolMessage.tool.state).toBe('running');
    expect(toolMessage.tool.completedAt).toBeNull();
    expect(toolMessage.tool.result).toBeUndefined();
  });

  it('closes subagent tools with sidechain activity once the session process that hosted them ended', () => {
    const state = createReducer();

    const subAgentTool: NormalizedMessage = {
      id: 'msg_subagent',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_subagent_1',
          name: 'SubAgent',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_subagent',
          parentUUID: null,
        },
      ],
    };

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      sidechainId: 'tool_subagent_1',
      content: [
        {
          type: 'text',
          text: 'Still working',
          uuid: 'uuid_sc_text',
          parentUUID: null,
        },
      ],
    };

    const result = reducer(state, [subAgentTool, sidechainText], null, {
      ownerProcessGoneSinceMs: 4000,
    });

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent');
    if (!toolMessage || toolMessage.kind !== 'tool-call') throw new Error('Expected SubAgent tool message');
    expect(toolMessage.tool.state).toBe('unavailable');
    expect(toolMessage.tool.completedAt).toBe(4000);
    expect(toolMessage.tool.result).toBeUndefined();
  });

  it('keeps subagent tools running when their sidechain spoke after the session was last seen', () => {
    const state = createReducer();

    const subAgentTool: NormalizedMessage = {
      id: 'msg_subagent',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_subagent_1',
          name: 'SubAgent',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_subagent',
          parentUUID: null,
        },
      ],
    };

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 5000,
      role: 'agent',
      isSidechain: true,
      sidechainId: 'tool_subagent_1',
      content: [
        {
          type: 'text',
          text: 'Still working',
          uuid: 'uuid_sc_text',
          parentUUID: null,
        },
      ],
    };

    const result = reducer(state, [subAgentTool, sidechainText], null, {
      ownerProcessGoneSinceMs: 4000,
    });

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent');
    if (!toolMessage || toolMessage.kind !== 'tool-call') throw new Error('Expected SubAgent tool message');
    expect(toolMessage.tool.state).toBe('running');
    expect(toolMessage.tool.completedAt).toBeNull();
  });

  it('restores unavailable subagent tools when sidechain activity arrives later', () => {
    const state = createReducer();

    const subAgentTool: NormalizedMessage = {
      id: 'msg_subagent',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_subagent_1',
          name: 'SubAgent',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_subagent',
          parentUUID: null,
        },
      ],
    };

    const readyEvent: NormalizedMessage = {
      id: 'ready_1',
      localId: null,
      createdAt: 1500,
      role: 'event',
      isSidechain: false,
      content: { type: 'ready' },
    };

    const closedResult = reducer(state, [subAgentTool, readyEvent]);
    const closedToolMessage = closedResult.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent');
    if (!closedToolMessage || closedToolMessage.kind !== 'tool-call') throw new Error('Expected SubAgent tool message');
    expect(closedToolMessage.tool.state).toBe('unavailable');
    expect(closedToolMessage.tool.completedAt).toBe(1500);
    expect(closedToolMessage.tool.result).toBeUndefined();

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1700,
      role: 'agent',
      isSidechain: true,
      sidechainId: 'tool_subagent_1',
      content: [
        {
          type: 'text',
          text: 'Still working',
          uuid: 'uuid_sc_text',
          parentUUID: null,
        },
      ],
    };

    const result = reducer(state, [sidechainText]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent');
    if (!toolMessage || toolMessage.kind !== 'tool-call') throw new Error('Expected SubAgent tool message');
    expect(toolMessage.tool.state).toBe('running');
    expect(toolMessage.tool.completedAt).toBeNull();
    expect(toolMessage.tool.result).toBeUndefined();
  });

  it('restores subagent tools when sidechain activity follows a synthetic interrupted placeholder', () => {
    const state = createReducer();

    const subAgentTool: NormalizedMessage = {
      id: 'msg_subagent',
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_subagent_1',
          name: 'SubAgent',
          input: { prompt: 'Search for files' },
          description: null,
          uuid: 'uuid_subagent',
          parentUUID: null,
        },
      ],
    };

    reducer(state, [subAgentTool]);

    const interruptedMessageId = state.toolIdToMessageId.get('tool_subagent_1');
    const interruptedMessage = interruptedMessageId ? state.messages.get(interruptedMessageId) : null;
    if (!interruptedMessage?.tool) throw new Error('Expected SubAgent tool message');
    interruptedMessage.tool.state = 'error';
    interruptedMessage.tool.completedAt = 1100;
    interruptedMessage.tool.result = { error: 'Request interrupted' };
    interruptedMessage.tool.permission = {
      id: 'tool_subagent_1',
      status: 'canceled',
      reason: 'Request interrupted',
      decision: 'abort',
    };

    expect(interruptedMessage?.tool?.state).toBe('error');
    expect(interruptedMessage?.tool?.result).toEqual({ error: 'Request interrupted' });

    const sidechainText: NormalizedMessage = {
      id: 'msg_sc_text',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      sidechainId: 'tool_subagent_1',
      content: [
        {
          type: 'text',
          text: 'Still working',
          uuid: 'uuid_sc_text',
          parentUUID: null,
        },
      ],
    };

    const result = reducer(state, [sidechainText]);

    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'SubAgent');
    if (!toolMessage || toolMessage.kind !== 'tool-call') throw new Error('Expected SubAgent tool message');
    expect(toolMessage.tool.state).toBe('running');
    expect(toolMessage.tool.completedAt).toBeNull();
    expect(toolMessage.tool.result).toBeUndefined();
    expect(toolMessage.tool.permission?.status).toBe('approved');
    expect(toolMessage.tool.permission?.reason).toBeUndefined();
    expect(toolMessage.tool.permission?.decision).toBeUndefined();
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

  it('does not split sidechain thinking when a whitespace-only agent text keepalive interleaves', () => {
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
          thinking: 'Respond',
          uuid: 'uuid_sc_thinking_1',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainThinking1 as any).sidechainId = 'tool_task_1';

    const sidechainKeepalive: NormalizedMessage = {
      id: 'msg_sc_keepalive',
      localId: null,
      createdAt: 1250,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'text',
          text: '\n',
          uuid: 'uuid_sc_keepalive',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainKeepalive as any).sidechainId = 'tool_task_1';

    const sidechainThinking2: NormalizedMessage = {
      id: 'msg_sc_thinking_2',
      localId: null,
      createdAt: 1300,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'thinking',
          thinking: 'ing',
          uuid: 'uuid_sc_thinking_2',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainThinking2 as any).sidechainId = 'tool_task_1';

    const result = reducer(state, [taskTool, sidechainRoot, sidechainThinking1, sidechainKeepalive, sidechainThinking2]);
    const toolMessage = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.name === 'Task') as any;
    expect(toolMessage).toBeTruthy();

    const thinkingChildren = toolMessage.children.filter((m: any) => m.kind === 'agent-text' && m.isThinking);
    expect(thinkingChildren).toHaveLength(1);
    expect(thinkingChildren[0]?.text).toBe('Responding');
  });

  it('keeps orphan sidechain messages out of the root transcript when the parent tool-call is missing', () => {
    const state = createReducer();

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

    const sidechainTool: NormalizedMessage = {
      id: 'msg_sc_tool',
      localId: null,
      createdAt: 1200,
      role: 'agent',
      isSidechain: true,
      content: [
        {
          type: 'tool-call',
          id: 'call_inner_1',
          name: 'Read',
          input: { path: 'a.txt' },
          description: null,
          uuid: 'uuid_sc_tool',
          parentUUID: 'uuid_sc_root',
        },
      ],
    } as any;
    (sidechainTool as any).sidechainId = 'tool_task_1';

    const result = reducer(state, [sidechainRoot, sidechainTool]);

    expect(result.messages).toEqual([]);
    expect(state.sidechains.get('tool_task_1')?.some((m) => m.tool?.name === 'Read')).toBe(true);
  });
});
