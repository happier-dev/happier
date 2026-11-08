import { expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';

it.each(['agent', 'mcp'] as const)('discovers Doc suggestions from a passage rewrite request on %s', async surface => {
  const executor = createActionExecutor({});
  for (const query of ['suggest a rewrite of this passage', 'Doc suggestion']) {
    const search = await executor.execute('action.spec.search', { query, limit: 5 }, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    });
    expect(search.ok, query).toBe(true);
    if (!search.ok) throw new Error('Doc Action discovery failed');
    expect.soft(search.result.actionSpecs.map(spec => spec.id), query).toContain('doc.edit.propose');
  }
});
