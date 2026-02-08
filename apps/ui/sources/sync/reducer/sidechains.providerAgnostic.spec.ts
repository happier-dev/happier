import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

describe('sidechains (provider-agnostic)', () => {
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
});
