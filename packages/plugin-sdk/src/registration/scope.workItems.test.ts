import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '../index.public.js';
import * as publicSdk from '../index.public.js';
import { createPluginTestkit } from '../testing/index.js';
import { createPluginRegistrationScope } from './scope.js';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { derivePluginClientContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { PluginWorkItemsRuntime } from '../workItems.js';
import type { PluginAccountActionContext } from '../actions/contracts.js';

const client = { artifactId: 'work-runtime', exportName: 'activate' };
const declaration = { id: 'work-items', client, platforms: ['web'] };
const item = { title: 'External work', category: 'started' as const, linkedSessions: [{ serverId: 'home', sessionId: 'session' }] };

async function createWorkItemContext(): Promise<PluginAccountActionContext> {
  const contexts: PluginAccountActionContext[] = [];
  const plugin = definePlugin({ id: 'com.acme.work', version: '1.0.0', actions: {
    context: { title: 'Context fixture', execution: { target: 'account', account: client },
      run: async (_input, context) => { contexts.push(context); return null; } },
  } });
  const host = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
  onTestFinished(() => host.dispose());
  await host.invokeAction('context', null);
  if (!contexts[0]) throw new Error('Expected Account invocation context');
  return contexts[0];
}

describe('public live work items', () => {
  it('declares a named transition Action with the public canonical schema and exact operands', async () => {
    const received: unknown[] = [];
    const plugin = definePlugin({ id: 'com.acme.transition', version: '1.0.0',
      workItems: { 'work-items': { client, platforms: ['web'], transitionAction: 'transition' } },
      actions: { transition: { title: 'Transition', surfaces: ['ui'], dangerLevel: 'safe',
        inputSchema: publicSdk.PluginWorkItemTransitionInputV1Schema,
        run: async input => { received.push(input); return { changed: true }; },
      } },
    });
    const host = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const input = { serverId: 'home', itemId: 'task', transitionId: 'start' };
    try {
      await expect(host.invokeAction('transition', { ...input, unexpected: true })).rejects.toThrow();
      await expect(host.invokeAction('transition', input)).resolves.toEqual({ changed: true });
      expect(received).toEqual([input]);
      expect(plugin.manifest.contributes?.workItems?.[0]?.transitionAction).toBe('transition');
    } finally { await host.dispose(); }
  });
  it('admits one declared resolver through the public author and registration owners', async () => {
    const context = await createWorkItemContext();
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
      findLinked: async () => ({ itemIds: ['known'], complete: true }), watch: (_request, changed) => { invalidate = changed; return () => { cleaned = true; }; } };
    scope.api.workItems.register('work-items', runtime);
    const entry = scope.commit().find(value => value.family === 'workItems');
    if (entry?.family !== 'workItems') throw new Error('Missing work items registration');
    runtime.resolve = async () => ({ known: { ...item, title: 'Mutated callback' }, missing: null });
    expect(await entry.value.resolve({ serverId: 'home', itemIds: ['known', 'missing', 'constructor', '__proto__'] }, context)).toEqual(
      Object.fromEntries([['known', { ...item, title: 'Mutated callback' }], ['missing', null], ['constructor', null], ['__proto__', null]]),
    );
    expect(await entry.value.findLinked?.({ serverId: 'home', sessionIds: ['session'] }, context)).toEqual({ itemIds: ['known'], complete: true });
    let changes = 0;
    const stop = entry.value.watch?.({ serverId: 'home', itemIds: ['known'], sessionIds: ['session'] }, () => { changes++; }, context);
    invalidate?.();
    expect(changes).toBe(1);
    stop?.();
    expect(cleaned).toBe(true);
    await scope.dispose();
    expect(scope.registrations()).toEqual([]);
    expect(() => scope.api.workItems.register('work-items', runtime)).toThrow();
  });

  it('rejects malformed or unrelated item results at the captured callback boundary', async () => {
    const context = await createWorkItemContext();
    const contributes = PluginContributesV2Schema.parse({ workItems: [declaration] });
    const rights = derivePluginClientContributionRegistrationRights(contributes, { ...client, platform: 'web' });
    for (const result of [{ known: { ...item, authority: 'write' } }, { known: { ...item, linkedSessions: [{ sessionId: 'bare' }] } }, { foreign: item }]) {
      const scope = createPluginRegistrationScope({ pluginId: 'com.acme.work', target: { realm: 'client', ...client, platform: 'web' }, rights });
      // Executable plugin code can return malformed values despite its declared type.
      scope.api.workItems.register('work-items', { resolve: async () => result as never });
      const entry = scope.commit().find(value => value.family === 'workItems');
      if (entry?.family !== 'workItems') throw new Error('Missing work items registration');
      await expect(entry.value.resolve({ serverId: 'home', itemIds: ['known'] }, context)).rejects.toThrow();
      await scope.dispose();
    }
    expect(PluginContributesV2Schema.safeParse({ workItems: [{ ...declaration, id: 'second-resolver' }] }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ workItems: [declaration, declaration] }).success).toBe(false);
  });
});
