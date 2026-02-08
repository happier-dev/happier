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
});
