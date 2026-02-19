import { describe, it, expect } from 'vitest';
import { normalizeRawMessage } from './normalize';

describe('typesRaw.normalizeRawMessage', () => {
  it('preserves provider-emitted sidechainId for sidechain messages', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'text', text: 'hello' }],
          },
          isSidechain: true,
          sidechainId: 'tool_task_123',
          uuid: 'uuid_sc_1',
          parentUuid: null,
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg1', null, 1000, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_123');
  });

  it('preserves sidechainId for ACP messages and marks them as sidechains', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'opencode',
        data: {
          type: 'message',
          message: 'subtask says hi',
          sidechainId: 'tool_task_1',
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg2', null, 1001, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_1');
  });

  it('preserves sidechainId on user tool_result payloads and marks them as sidechains', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool_read_1', content: 'ok' }],
          },
          isSidechain: false,
          sidechainId: 'tool_task_2',
          uuid: 'uuid_sc_user_1',
          parentUuid: 'uuid_sc_root',
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg3', null, 1002, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_2');
  });

  it('maps Claude parent_tool_use_id to sidechainId for assistant sidechain messages', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          parent_tool_use_id: 'tool_task_555',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'text', text: 'sidechain hello' }],
          },
          uuid: 'uuid_sc_assistant_1',
          parentUuid: null,
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg4', null, 1003, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_555');
  });

  it('uses meta.sidechainId as a fallback when output sidechainId is missing', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'text', text: 'hello from sidechain' }],
          },
          // Important: some streaming paths attach sidechainId to meta before output.data is fully materialized.
          // This must still be treated as a sidechain message so tool calls do not leak into the main transcript.
          isSidechain: false,
          uuid: 'uuid_sc_assistant_meta_1',
          parentUuid: 'uuid_parent',
        },
      },
      meta: { source: 'cli', sidechainId: 'tool_task_meta_1' },
    };

    const normalized = normalizeRawMessage('msg_meta_1', null, 1004, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_meta_1');
  });

  it('reads output.data.sidechain_id and output.data.is_sidechain for sidechain detection (snake_case)', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'text', text: 'hello snake' }],
          },
          is_sidechain: true,
          sidechain_id: 'tool_task_snake_1',
          uuid: 'uuid_sc_snake_1',
          parentUuid: null,
        },
      },
      meta: { source: 'cli' },
    };

    const normalized = normalizeRawMessage('msg_snake_1', null, 1006, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_snake_1');
  });

  it('uses meta.sidechain_id as a fallback when meta uses snake_case', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'text', text: 'hello meta snake' }],
          },
          uuid: 'uuid_sc_meta_snake_1',
          parentUuid: null,
        },
      },
      meta: { source: 'cli', sidechain_id: 'tool_task_meta_snake_1' },
    };

    const normalized = normalizeRawMessage('msg_meta_snake_1', null, 1007, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_meta_snake_1');
  });

  it('uses meta.sidechainId as a fallback for ACP messages when payload sidechainId is missing', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'opencode',
        data: {
          type: 'tool-call',
          callId: 'call_1',
          id: 'msg_1',
          name: 'Bash',
          input: { command: 'echo hi' },
        },
      },
      meta: { source: 'cli', sidechainId: 'tool_task_meta_acp_1' },
    };

    const normalized = normalizeRawMessage('msg_acp_meta_1', null, 1005, raw);
    expect(normalized).not.toBeNull();
    expect((normalized as any).isSidechain).toBe(true);
    expect((normalized as any).sidechainId).toBe('tool_task_meta_acp_1');
  });
});
