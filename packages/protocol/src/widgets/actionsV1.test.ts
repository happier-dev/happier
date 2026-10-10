import { expect, it } from 'vitest';

it('admits group references through the deferred Action graph without widening their surface authority', async () => {
  const { WidgetInstanceActionInputSchemasV1 } = await import('./actionsV1.js');
  const schema = WidgetInstanceActionInputSchemasV1['widgets.group.ungroup'];
  const ref = { surface: { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } }, instanceId: 'group' };

  expect(schema.parse({ ref })).toEqual({ ref });
  expect(schema.safeParse({ ref: { ...ref, surface: { ...ref.surface, owner: { kind: 'sessionBoard', sessionId: 'session' } } } }).success).toBe(false);
  expect(schema.safeParse({ ref: { ...ref, extra: true } }).success).toBe(false);
});
