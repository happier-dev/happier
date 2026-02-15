import { describe, expect, it } from 'vitest';

import { registerHappierMcpBridgeTools } from './registerHappierMcpBridgeTools';

describe('registerHappierMcpBridgeTools', () => {
  it('registers Happier MCP tools and forwards calls', async () => {
    const calls: any[] = [];
    const registrar = {
      registerTool: (name: string, _def: any, handler: (args: any) => Promise<any>) => {
        calls.push({ name, handler });
      },
    };

    const forwarded: any[] = [];
    registerHappierMcpBridgeTools(registrar as any, {
      callHttpTool: async (name: string, args: unknown) => {
        forwarded.push({ name, args });
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    });

    const names = calls.map((c) => c.name);
    expect(names).toContain('change_title');
    expect(names).toContain('action_spec_list');
    expect(names).toContain('action_spec_get');
    expect(names).toContain('review_start');
    expect(names).toContain('plan_start');
    expect(names).toContain('delegate_start');
    expect(names).toContain('voice_agent_start');
    expect(names).toContain('execution_run_start');
    expect(names).toContain('execution_run_list');
    expect(names).toContain('execution_run_get');
    expect(names).toContain('execution_run_send');
    expect(names).toContain('execution_run_stop');
    expect(names).toContain('execution_run_action');

    const start = calls.find((c) => c.name === 'execution_run_start');
    const res = await start.handler({ intent: 'review', backendId: 'claude', instructions: 'Review.' });
    expect(res.isError).toBe(false);
    expect(forwarded[0]).toEqual({
      name: 'execution_run_start',
      args: { intent: 'review', backendId: 'claude', instructions: 'Review.' },
    });
  });
});
