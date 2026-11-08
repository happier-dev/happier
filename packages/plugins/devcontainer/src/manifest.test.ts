import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { DEVCONTAINER_PLUGIN } from './manifest.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';

describe('Devcontainer public-author declaration', () => {
  it('offers a qualified runtime repair without requiring the advanced CLI for image creation', async () => {
    const requested: string[] = [];
    const services = { exec: { run: async () => { throw new Error('missing runtime must not execute'); } },
      managedServices: { dependencies: { status: async (id: string) => {
        requested.push(id); return { id, state: 'missing', supported: true };
      } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ available: false,
        prerequisites: [{ requirement: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'docker' } },
          status: 'unavailable', repairAction: { action: { pluginId: 'happier.devcontainer', localId: 'runtime-install-docs' }, input: { runtime: 'docker' } } }] });
      expect(requested).toEqual(['docker', 'podman']);
      expect(await kit.invokeAction('options', { runtime: 'podman', configuration: { kind: 'image', image: 'example:latest' } }, { surface: 'plugin' }))
        .toMatchObject({ base: { available: false, prerequisites: [{ requirement: { id: { localId: 'podman' } },
          repairAction: { input: { runtime: 'podman' } } }] } });
    } finally { await kit.dispose(); }
  });

  it('keeps a Podman-only controller available without acquiring the advanced CLI', async () => {
    const requested: string[] = [];
    const services = { exec: { run: async () => ({ termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
      stdout: new TextEncoder().encode('5.0.0'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }) },
      managedServices: { dependencies: { status: async (id: string) => {
        requested.push(id);
        return id === 'podman' ? { state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id } } }
          : { state: 'missing', supported: true };
      } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toEqual({ available: true });
      expect(requested).toEqual(['docker', 'podman']);
    } finally { await kit.dispose(); }
  });

  it('installs the advanced CLI through the managed JavaScript dependency owner', async () => {
    const ensured: string[] = [];
    const services = { managedServices: { dependencies: { ensure: async (id: string) => { ensured.push(id); return {}; } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      await expect(kit.invokeAction('install-cli', {}, { surface: 'plugin' })).resolves.toBeNull();
      expect(ensured).toEqual(['devcontainer-cli']);
      expect(DEVCONTAINER_PLUGIN.manifest.contributes.managedDependencies.find(item => item.id === 'devcontainer-cli')?.sources)
        .toContainEqual(expect.objectContaining({ kind: 'managedJavaScriptPackage', packageName: '@devcontainers/cli' }));
    } finally { await kit.dispose(); }
  });
  it('keeps Podman creation available when Docker is installed but its daemon is unavailable', async () => {
    const services = { exec: { run: async ({ executable }: { executable: { id: { localId: string } } }) => ({
      termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: executable.id.localId === 'docker' ? 1 : 0 } },
      stdout: new TextEncoder().encode('5.0.0'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }) },
      managedServices: { dependencies: { status: async (id: string) => ({ state: 'ready',
        executable: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id } } }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try { expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toEqual({ available: true }); }
    finally { await kit.dispose(); }
  });
  it('offers the CLI repair only when an advanced configuration needs it', async () => {
    const services = { exec: { run: async () => { throw new Error('unavailable CLI must not evaluate configuration'); } },
      managedServices: { dependencies: { status: async (id: string) => id === 'docker'
        ? { state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id } } }
        : { state: 'missing', supported: true } } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('options', { workspaceFolder: '/workspace', configuration: { kind: 'inline', config: '{}' } }, { surface: 'plugin' }))
        .toMatchObject({ base: { available: false, prerequisites: [{ requirement: { id: { localId: 'devcontainer-cli' } },
          repairAction: { action: { pluginId: 'happier.devcontainer', localId: 'install-cli' }, input: {} } }] } });
    } finally { await kit.dispose(); }
  });
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
    expect(await handlers.get('check')!({}, context)).toMatchObject({ available: false, code: 'provider_unavailable' });
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
