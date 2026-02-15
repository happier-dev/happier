import { describe, expect, it } from 'vitest';

import { createActionSpecMcpTools } from './actionSpecTools';

function parse(res: any): any {
  return JSON.parse(res.content[0]!.text);
}

describe('createActionSpecMcpTools', () => {
  it('lists action specs as JSON-safe objects', async () => {
    const tools = createActionSpecMcpTools();
    const res = await tools.action_spec_list.handler({});
    expect(res.isError).toBe(false);

    const payload = parse(res);
    expect(Array.isArray(payload.actionSpecs)).toBe(true);
    expect(payload.actionSpecs.some((s: any) => s.id === 'review.start')).toBe(true);
  });

  it('gets a single action spec by id', async () => {
    const tools = createActionSpecMcpTools();
    const res = await tools.action_spec_get.handler({ id: 'review.start' });
    expect(res.isError).toBe(false);

    const payload = parse(res);
    expect(payload.actionSpec?.id).toBe('review.start');
    expect(payload.actionSpec?.inputSchema).toBeUndefined();
  });
});

