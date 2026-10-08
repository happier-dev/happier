import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { DEVCONTAINER_PLUGIN } from './manifest.js';

describe('Devcontainer public-author declaration', () => {
  it('uses the common family and makes prerequisite discovery non-evaluating', async () => {
    const handlers = new Map<string, ActionHandler>();
    // Host registration and dependency availability are the external boundary.
    const api = { actions: { register(id: string, handler: ActionHandler) {
      handlers.set(id, handler); return { dispose() {} };
    } } } as unknown as PluginApi;
    await DEVCONTAINER_PLUGIN.activate(api);
    const context = { signal: new AbortController().signal, invokedAtMs: 42,
      services: { exec: { run: async () => { throw new Error('missing dependencies must not launch hooks'); } },
        managedServices: { dependencies: { status: async (id: string) => ({ id, state: 'missing', supported: true }) } } },
    } as unknown as PluginInvocationContext;
    expect(await handlers.get('check')!({}, context)).toEqual({ available: false, code: 'provider_unavailable' });
    expect(DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners).toMatchObject([{ resourceKind: 'devcontainer',
      actions: { acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
      bootstrapTransport: { exec: 'exec', putFile: 'putFile' } }]);
  });
});
