import { describe, expect, it } from 'vitest';

import { DefaultTransport } from '@/agent/transport';
import type { TransportHandler } from '@/agent/transport';
import { ACP_PLAN_TOOL_CALL_ID, handlePlanUpdate } from '../events';
import type { HandlerContext, SessionUpdate } from '../types';

function makeCtx(transport: TransportHandler) {
  const emitted: any[] = [];
  const ctx = { transport, emit: (m: any) => emitted.push(m) } as unknown as HandlerContext;
  return { ctx, emitted };
}

describe('handlePlanUpdate (generic ACP plan -> shared TodoWrite checklist)', () => {
  it('normalizes a standard ACP plan update into a TodoWrite tool-call + tool-result', () => {
    const { ctx, emitted } = makeCtx(new DefaultTransport('test'));
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Analyze the codebase', priority: 'high', status: 'pending' },
        { content: 'Write tests', priority: 'medium', status: 'in_progress' },
        { content: 'Ship it', priority: 'low', status: 'completed' },
      ],
    };

    const result = handlePlanUpdate(update, ctx);

    expect(result).toEqual({ handled: true });
    expect(emitted).toHaveLength(2);
    const todos = [
      { content: 'Analyze the codebase', status: 'pending', priority: 'high' },
      { content: 'Write tests', status: 'in_progress', priority: 'medium' },
      { content: 'Ship it', status: 'completed', priority: 'low' },
    ];
    expect(emitted[0]).toEqual({ type: 'tool-call', toolName: 'TodoWrite', args: { todos }, callId: ACP_PLAN_TOOL_CALL_ID });
    expect(emitted[1]).toEqual({ type: 'tool-result', toolName: 'TodoWrite', result: { todos }, callId: ACP_PLAN_TOOL_CALL_ID });
  });

  it('does not let a legacy transport option discard a standard ACP plan', () => {
    const transport = { ...new DefaultTransport('cursor-like'), suppressAcpPlanUpdate: () => true } as unknown as TransportHandler;
    const { ctx, emitted } = makeCtx(transport);
    const result = handlePlanUpdate(
      { sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending' }] },
      ctx,
    );
    expect(result).toEqual({ handled: true });
    expect(emitted).toHaveLength(2);
    expect(emitted.map((message) => message.type)).toEqual(['tool-call', 'tool-result']);
  });

  it('returns not-handled when there is no plan payload', () => {
    const { ctx, emitted } = makeCtx(new DefaultTransport('test'));
    expect(handlePlanUpdate({ sessionUpdate: 'tool_call' }, ctx)).toEqual({ handled: false });
    expect(emitted).toHaveLength(0);
  });
});
