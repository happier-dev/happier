import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { DEVCONTAINER_PLUGIN } from './manifest.js';

describe('Devcontainer public-author declaration', () => {
  it('admits the public manifest before activating its native roles and keeps prerequisite discovery non-evaluating', async () => {
    const admitted = parsePluginManifest(DEVCONTAINER_PLUGIN.manifest);
    if (!admitted.ok) throw new Error(`The public native contribution was not admitted: ${JSON.stringify(admitted.diagnostics)}`);
    const handlers = new Map<string, ActionHandler>();
    // Host registration and dependency availability are the external boundary.
    const api = { actions: { register(id: string, handler: ActionHandler) {
      expect(admitted.manifest.contributes.actions.some(action => action.id === id)).toBe(true);
      handlers.set(id, handler); return { dispose() {} };
    } } } as unknown as PluginApi;
    await DEVCONTAINER_PLUGIN.activate(api);
    const context = { signal: new AbortController().signal, invokedAtMs: 42,
      services: { exec: { run: async () => { throw new Error('missing dependencies must not launch hooks'); } },
        managedServices: { dependencies: { status: async (id: string) => {
          expect(admitted.manifest.contributes.managedDependencies.some(dependency => dependency.id === id)).toBe(true);
          return { id, state: 'missing', supported: true };
        } } } },
    } as unknown as PluginInvocationContext;
    expect(await handlers.get('check')!({}, context)).toEqual({ available: false, code: 'provider_unavailable' });
    const provisioner = admitted.manifest.contributes.machineProvisioners[0]!;
    const transport = provisioner.bootstrapTransport;
    expect(transport?.kind).toBe('native');
    if (transport?.kind !== 'native') throw new Error('The public contribution did not admit native bootstrap');
    expect(handlers.has(transport.putFile)).toBe(true);
    expect(admitted.manifest.contributes.machineProvisioners).toMatchObject([{ resourceKind: 'devcontainer',
      actions: { acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
      bootstrapTransport: { exec: 'exec', putFile: 'put-file' } }]);
  });
});
