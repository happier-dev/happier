import { expect, it } from 'vitest';
import { createPluginMountedResourceDemand } from './pluginMountedResourceDemand';

it('groups only mounted subjects and publishes only the changed subject, retaining known zero', () => {
  const owner = createPluginMountedResourceDemand<Readonly<{ group: string; subject: string }>, Readonly<{ value?: number }>>();
  const release = Array.from({ length: 40 }, (_, i) => owner.mount(String(i), { group: i < 20 ? 'a' : 'b', subject: String(i) }));
  expect([...owner.demands()].length).toBe(40);
  const first = owner.read('0');
  expect(first).toBeNull();
  let changed = 0;
  let untouched = 0;
  owner.subscribe('0', () => changed++);
  owner.subscribe('1', () => untouched++);
  owner.publish('0', { value: 0 });
  expect(owner.read('0')).toEqual({ value: 0 });
  owner.publish('0', { value: 0 });
  expect(changed).toBe(1);
  expect(untouched).toBe(0);
  for (const dispose of release) dispose();
  expect([...owner.demands()]).toEqual([]);
  expect(owner.read('0')).toBeNull();
});
