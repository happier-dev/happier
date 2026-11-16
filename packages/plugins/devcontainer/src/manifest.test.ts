import { describe, expect, it, vi } from 'vitest';
import { platform } from 'node:os';
import { DOCKER_ENGINE_RECIPE_REF_V1 } from '@happier-dev/plugin-sdk';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { DEVCONTAINER_PLUGIN } from './manifest.js';
import { installDockerRuntime } from './machine/runtimeRepair.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';

// The answering controller's OS is an external boundary; recipe support stays
// with the setup planner rather than being duplicated in this provider.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: vi.fn(actual.platform) };
});

describe('Devcontainer public-author declaration', () => {
  it.each([['amd64', 'x64'], ['arm64', 'arm64']] as const)('projects the inspected %s image target for the clean CLI supplier', async (nativeArch, arch) => {
    const services = { exec: { run: async () => ({ stdout: Buffer.from(JSON.stringify([{ Id: 'sha256:base',
      Os: 'linux', Architecture: nativeArch, Config: { User: 'developer', WorkingDir: '/workspace' } }])),
      stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false,
      termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } }) },
      managedServices: { dependencies: { status: async () => ({ state: 'ready', executable: {
        kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: 'docker' },
      } }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('options', { configuration: { kind: 'image', image: 'example:latest' } }, { surface: 'plugin' }))
        .toMatchObject({ base: { nativeFacts: { preparationGuest: { target: { os: 'linux', arch }, remoteHomeDir: '/opt/happier' } } } });
    } finally { await kit.dispose(); }
  });
  it('offers controller-local isolation without promising nested Agent sandbox support', () => {
    // P-DEV r3: arbitrary images and authored configs do not establish the
    // privileges required by an Agent's native sandbox.
    expect(DEVCONTAINER_PLUGIN.manifest.contributes.machineProvisioners).toContainEqual(
      expect.objectContaining({ id: 'devcontainer', sessionPlacement: {
        kind: 'controller-local', supportsAgentNativeSandbox: false,
      } }),
    );
  });
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
          status: 'unavailable', repairAction: { action: { pluginId: 'happier.devcontainer', localId: platform() === 'linux' ? 'install-runtime' : 'runtime-install-docs' },
            input: platform() === 'linux' ? {} : { runtime: 'docker' } } }] });
      expect(requested).toEqual(['docker', 'podman']);
      if (platform() === 'linux') expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({
        prerequisites: [{ setupSources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
          ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: { mode: 'rootless', daemonConfig: {} },
        } }] } }] }],
      });
      expect(await kit.invokeAction('options', { runtime: 'podman', configuration: { kind: 'image', image: 'example:latest' } }, { surface: 'plugin' }))
        .toMatchObject({ base: { available: false, prerequisites: [{ requirement: { id: { localId: 'podman' } },
          repairAction: { input: { runtime: 'podman' } } }] } });
    } finally { await kit.dispose(); }
  });

  it('repairs Docker through the controller setup recipe and preserves its operation result', async () => {
    const sources = [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe',
      selection: { ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: { mode: 'rootless', daemonConfig: {} } } }] } }];
    const plan = { desiredRevision: 0, sources, exclusions: [], support: [], recipePlans: [] };
    // The host Action transport is the boundary; the plugin's Plan-to-Apply
    // adapter remains real.
    const settled = { kind: 'found', operation: { version: 1, operationId: 'docker-setup', revision: 1,
      actionId: 'machines.setup.apply', state: 'succeeded', scope: { accountId: 'account', machineId: 'controller' },
      title: 'Docker setup', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'unsupported' } };
    const execute = vi.fn(async (action: string): Promise<unknown> => action === 'machines.setup.plan' ? plan
      : action === 'action.operations.get' ? settled : { operationId: 'docker-setup' });
    const services = { actions: { getCurrentExecutionRouting: async () => ({ serverIdentityId: 'home', machineId: 'controller', pluginId: 'happier.devcontainer' }),
      execute } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).resolves.toEqual({ operationId: 'docker-setup' });
      expect(execute).toHaveBeenCalledWith('machines.setup.plan', { homeId: 'home', machineId: 'controller', sources }, expect.anything());
      expect(execute).toHaveBeenCalledWith('machines.setup.apply', { homeId: 'home', machineId: 'controller', targets: [{
        homeId: 'home', machineId: 'controller', desiredRevision: 0, sources, exclusions: [], recipePlans: [],
      }] }, expect.anything());
      // Apply is an admission receipt, not installation completion. Retry can
      // run only after the incumbent operation owner settles the installer.
      expect(execute).toHaveBeenCalledWith('action.operations.get', { serverId: 'home', machineId: 'controller',
        operationId: 'docker-setup', waitForTerminal: true }, expect.anything());
      const failure = Object.assign(new Error('Setup unavailable'), { code: 'admin_access_unavailable' });
      execute.mockRejectedValueOnce(failure);
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).rejects.toMatchObject({
        code: 'plugin_action_execution_failed', data: { failureCause: { errorCode: 'admin_access_unavailable' } },
      });
      execute.mockClear();
      const approval = { kind: 'approval_request_created', artifactId: 'setup-review', actionId: 'machines.setup.plan' };
      execute.mockResolvedValueOnce(approval);
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).resolves.toEqual(approval);
      expect(execute).not.toHaveBeenCalledWith('machines.setup.apply', expect.anything(), expect.anything());
      execute.mockResolvedValueOnce(plan).mockResolvedValueOnce({ operationId: 'docker-setup' }).mockResolvedValueOnce({
        ...settled, operation: { ...settled.operation, state: 'failed',
          error: { errorCode: 'admin_access_unavailable', error: 'Setup unavailable' } },
      });
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).rejects.toMatchObject({ code: 'admin_access_unavailable' });
    } finally { await kit.dispose(); }
  });

  it.each([undefined, 'group'] as const)('proposes Docker mode %s before approval without starting installation', async mode => {
    // Plan approval is a host boundary; the real repair adapter must stop there.
    const approval = { kind: 'approval_request_created', artifactId: 'setup-review', actionId: 'machines.setup.plan' };
    const execute = vi.fn(async () => approval);
    const context = { signal: new AbortController().signal, services: { actions: {
      getCurrentExecutionRouting: async () => ({ serverIdentityId: 'home', machineId: 'controller', pluginId: 'happier.devcontainer' }),
      execute,
    } } } as unknown as PluginInvocationContext;
    await expect(installDockerRuntime(context, mode === undefined ? {} : { mode })).resolves.toEqual(approval);
    expect(execute).toHaveBeenCalledExactlyOnceWith('machines.setup.plan', { homeId: 'home', machineId: 'controller',
      sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
        ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: { mode: mode ?? 'rootless', daemonConfig: {} },
      } }] } }],
    }, expect.anything());
  });

  it('passes the chosen Docker group recipe variant through shared repair', async () => {
    const sources = [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe',
      selection: { ref: DOCKER_ENGINE_RECIPE_REF_V1, inputs: { mode: 'group', daemonConfig: {} } } }] } }];
    const execute = vi.fn(async (action: string): Promise<unknown> => action === 'machines.setup.plan'
      ? { desiredRevision: 0, sources, exclusions: [], support: [], recipePlans: [] }
      : action === 'action.operations.get' ? { kind: 'found', operation: {
        version: 1, operationId: 'group-setup', revision: 1, actionId: 'machines.setup.apply', state: 'succeeded',
        scope: { accountId: 'account', machineId: 'controller' }, title: 'Docker setup', createdAt: 1,
        startedAt: 1, settledAt: 2, cancellation: 'unsupported',
      } } : { operationId: 'group-setup' });
    const services = { actions: { getCurrentExecutionRouting: async () => ({ serverIdentityId: 'home', machineId: 'controller', pluginId: 'happier.devcontainer' }),
      execute } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      await expect(kit.invokeAction('install-runtime', { mode: 'group' }, { surface: 'plugin' })).resolves.toEqual({ operationId: 'group-setup' });
      expect(execute).toHaveBeenCalledWith('machines.setup.plan', { homeId: 'home', machineId: 'controller', sources }, expect.anything());
    } finally { await kit.dispose(); }
  });

  it.each(['darwin', 'win32'] as const)('keeps the official runtime guide on %s where no Engine recipe is supported', async os => {
    const previous = platform();
    vi.mocked(platform).mockReturnValue(os);
    const services = { managedServices: { dependencies: { status: async () => ({ state: 'missing', supported: true }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ prerequisites: [{
        repairAction: { action: { localId: 'runtime-install-docs' }, input: { runtime: 'docker' } },
      }] });
    } finally { vi.mocked(platform).mockReturnValue(previous); await kit.dispose(); }
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
