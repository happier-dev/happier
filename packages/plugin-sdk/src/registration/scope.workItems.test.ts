import { describe, expect, it } from 'vitest';
import { definePlugin } from '../index.public.js';
import { createPluginRegistrationScope } from './scope.js';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { PluginWorkItemsRuntime } from '../workItems.js';

const client = { artifactId: 'work-runtime', exportName: 'activate' };
const declaration = { id: 'work-items', client, platforms: ['web'] };
const item = { title: 'External work', category: 'started' as const, linkedSessions: [{ serverId: 'home', sessionId: 'session' }] };

describe('public live work items', () => {
  it('admits one declared resolver through the public author and registration owners', async () => {
    const plugin = definePlugin({ id: 'com.acme.work', version: '1.0.0', workItems: { 'work-items': { client, platforms: ['web'] } } });
    const contributes = PluginContributesV2Schema.parse(plugin.manifest.contributes);
    expect(contributes.workItems).toEqual([declaration]);
    const rights = derivePluginClientContributionRegistrationRights(contributes, { ...client, platform: 'web' });
    expect(rights).toContainEqual({ family: 'workItems', localId: 'work-items', target: { realm: 'client', ...client, platforms: ['web'] } });
    const denied = createPluginRegistrationScope({ pluginId: 'com.other.work', target: { realm: 'client', ...client, platform: 'web' }, rights: [] });
    expect(() => denied.api.workItems.register('work-items', { resolve: async () => ({}) })).toThrow();
    const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'client', ...client, platform: 'web' }, rights });
    let invalidate: (() => void) | undefined;
    let cleaned = false;
    const runtime: PluginWorkItemsRuntime = { resolve: async () => ({ known: item, missing: null }),
      findLinked: async () => ['known'], watch: (_request, changed) => { invalidate = changed; return () => { cleaned = true; }; } };
    scope.api.workItems.register('work-items', runtime);
    const entry = scope.commit().find(value => value.family === 'workItems');
    if (entry?.family !== 'workItems') throw new Error('Missing work items registration');
    runtime.resolve = async () => ({ known: { ...item, title: 'Mutated callback' }, missing: null });
    expect(await entry.value.resolve({ serverId: 'home', itemIds: ['known', 'missing', 'constructor', '__proto__'] }, { signal: new AbortController().signal })).toEqual(
      Object.fromEntries([['known', { ...item, title: 'Mutated callback' }], ['missing', null], ['constructor', null], ['__proto__', null]]),
    );
    expect(await entry.value.findLinked?.({ serverId: 'home', sessionIds: ['session'] }, { signal: new AbortController().signal })).toEqual(['known']);
    let changes = 0;
    const stop = entry.value.watch?.({ serverId: 'home', itemIds: ['known'], sessionIds: ['session'] }, () => { changes++; });
    invalidate?.();
    expect(changes).toBe(1);
    stop?.();
    expect(cleaned).toBe(true);
    await scope.dispose();
    expect(scope.registrations()).toEqual([]);
    expect(() => scope.api.workItems.register('work-items', runtime)).toThrow();
  });

  it('rejects malformed or unrelated item results at the captured callback boundary', async () => {
    const contributes = PluginContributesV2Schema.parse({ workItems: [declaration] });
    const rights = derivePluginClientContributionRegistrationRights(contributes, { ...client, platform: 'web' });
    for (const result of [{ known: { ...item, authority: 'write' } }, { known: { ...item, linkedSessions: [{ sessionId: 'bare' }] } }, { foreign: item }]) {
      const scope = createPluginRegistrationScope({ pluginId: 'com.acme.work', target: { realm: 'client', ...client, platform: 'web' }, rights });
      // Executable plugin code can return malformed values despite its declared type.
      scope.api.workItems.register('work-items', { resolve: async () => result as never });
      const entry = scope.commit().find(value => value.family === 'workItems');
      if (entry?.family !== 'workItems') throw new Error('Missing work items registration');
      await expect(entry.value.resolve({ serverId: 'home', itemIds: ['known'] }, { signal: new AbortController().signal })).rejects.toThrow();
      await scope.dispose();
    }
    expect(PluginContributesV2Schema.safeParse({ workItems: [{ ...declaration, id: 'second-resolver' }] }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ workItems: [declaration, declaration] }).success).toBe(false);
  });
});
