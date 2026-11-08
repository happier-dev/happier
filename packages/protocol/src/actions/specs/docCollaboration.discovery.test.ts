import { expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';

it('distinguishes a requested Doc edit suggestion from a conversational reply draft in agent tool guidance', () => {
  const proposal = getActionSpec('doc.edit.propose');
  expect(proposal.description).toMatch(/reply draft/i);
  expect(getActionSpec('doc.comment.reply').description).toContain('doc.edit.propose');
});

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
