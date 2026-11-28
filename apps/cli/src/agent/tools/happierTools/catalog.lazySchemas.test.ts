import { expect, it } from 'vitest';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { getResolvedLazyDefinitionValue } from '@happier-dev/protocol/lazyZodSchema';

it('builds the built-in tool catalog without constructing Action input schemas, and still derives defaults on read', async () => {
  const toolSpecs = listActionSpecs().filter(spec => String(spec.bindings?.mcpToolName ?? '').trim());
  const constructed = () => toolSpecs.filter(spec => getResolvedLazyDefinitionValue(spec.inputSchema) !== spec.inputSchema).map(spec => spec.id);
  const before = constructed();
  const { HAPPIER_BUILT_IN_TOOLS } = await import('./catalog');
  const toolsByActionId = new Map(HAPPIER_BUILT_IN_TOOLS.flatMap(tool => tool.actionId ? [[tool.actionId, tool] as const] : []));
  expect(toolsByActionId.size).toBeGreaterThan(0);
  expect(before.length).toBeLessThan(toolSpecs.length);
  expect(constructed()).toEqual(before);

  for (const spec of toolSpecs) {
    expect(toolsByActionId.get(spec.id)?.contextualDefaults, spec.id).toEqual(spec.contextualDefaults);
  }
  expect(toolSpecs.some(spec => spec.contextualDefaults?.machineId === 'current_session_machine')).toBe(true);
});
