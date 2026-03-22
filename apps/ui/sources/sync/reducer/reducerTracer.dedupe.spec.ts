import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';
import { createTracer, traceMessages } from './reducerTracer';

describe('reducerTracer (dedupe keys)', () => {
  it('does not dedupe tool-call and tool-result messages that share the same UUID', () => {
    const state = createTracer();

    const toolUuid = 'tool_shared_uuid';
    const toolCall: NormalizedMessage = {
      id: 'm1',
      seq: 1,
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-call',
          id: 'tool_1',
          name: 'ReadFile',
          input: { path: 'package.json' },
          description: null,
          uuid: toolUuid,
          parentUUID: null,
        },
      ],
    };

    const toolResult: NormalizedMessage = {
      id: 'm2',
      seq: 2,
      localId: null,
      createdAt: 1001,
      role: 'agent',
      isSidechain: false,
      content: [
        {
          type: 'tool-result',
          tool_use_id: 'tool_1',
          content: '{"name":"demo"}',
          is_error: false,
          uuid: toolUuid,
          parentUUID: null,
        },
      ],
    };

    const traced = traceMessages(state, [toolCall, toolResult]);
    expect(traced).toHaveLength(2);
    expect(traced.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('does not dedupe streaming agent-text updates that reuse the same message id + uuid', () => {
    const state = createTracer();

    const sharedUuid = 'shared_uuid';
    const first: NormalizedMessage = {
      id: 'm1',
      seq: 1,
      localId: null,
      createdAt: 1000,
      role: 'agent',
      isSidechain: false,
      content: [{ type: 'text', text: 'CODE', uuid: sharedUuid, parentUUID: null }],
    };

    const second: NormalizedMessage = {
      ...first,
      createdAt: 1001,
      content: [{ type: 'text', text: 'X', uuid: sharedUuid, parentUUID: null }],
    };

    const traced = traceMessages(state, [first, second]);
    expect(traced).toHaveLength(2);
    expect(traced.map((m) => m.id)).toEqual(['m1', 'm1']);
  });
});
