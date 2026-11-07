import { expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';

it.each(['agent', 'mcp'] as const)('discovers Store browsing through action_spec_search on %s', async surface => {
  const executor = createActionExecutor({});
  expect(getActionSpec('action.spec.search').bindings?.mcpToolName).toBe('action_spec_search');
  for (const query of [
    'registries.items.list', 'registries.sources.list', 'registries.items.read',
    'Dokploy Store', 'Store registry', 'Dokploy app catalog', 'list Dokploy Store items', 'Coolify Store',
  ]) {
    const search = await executor.execute('action.spec.search', { query, limit: 5 }, {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    });
    expect(search.ok, query).toBe(true);
    if (!search.ok) throw new Error('Store Action discovery failed');
    const ids = search.result.actionSpecs.map(spec => spec.id);
    if (query.startsWith('registries.')) expect(ids[0], query).toBe(query);
    else expect.soft(ids, query).toEqual(expect.arrayContaining([
      'registries.items.list', 'registries.sources.list', 'registries.items.read',
    ]));
  }
});
