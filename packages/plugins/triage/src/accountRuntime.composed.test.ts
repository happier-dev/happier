import { describe, expect, it } from 'vitest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { activate } from './accountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('portable Account activation', () => {
  it('registers exactly the Account Actions and dynamic Resources declared by the full plugin', () => {
    const actions: string[] = [];
    const resources: string[] = [];
    // Host registration is the external boundary; handlers remain real and are registered without invocation.
    const host = {
      actions: { register(id: string) { actions.push(id); } },
      resources: { registerDynamicResource(id: string) { resources.push(id); } },
    } as PluginAccountApi;
    activate(host);
    expect(actions.sort()).toEqual(PLUGIN_MANIFEST.contributes.actions
      .filter(action => action.execution?.target === 'account').map(action => action.id).sort());
    expect(resources.sort()).toEqual(PLUGIN_MANIFEST.contributes.resources
      .filter(resource => resource.source === 'dynamic' && resource.execution?.target === 'account')
      .map(resource => resource.id).sort());
  });
});
