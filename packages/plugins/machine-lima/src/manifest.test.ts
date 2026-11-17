import { Buffer } from 'node:buffer';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema, prepareMachineProvisionerStoredSchemas, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { LIMA_PLUGIN, LIMA_RECONCILIATION_SCHEMAS } from './manifest.js';
import { LimaLaunchSchema, LimaResourceSchema } from './machine/schemas.js';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

const testDirectory = mkdtempSync(join(tmpdir(), 'happier-lima-actions-test-'));
afterAll(() => rmSync(testDirectory, { recursive: true, force: true }));
const resource = {
  instance: 'happier-action-test', store: join(testDirectory, 'store'), image: 'https://example.test/ubuntu.img',
  arch: 'aarch64', vmType: 'vz', cpus: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3, mounts: [],
};
const native = {
  name: resource.instance, dir: `${resource.store}/${resource.instance}`, status: 'Running',
  arch: resource.arch, vmType: resource.vmType, cpus: resource.cpus, memory: resource.memoryBytes, disk: resource.diskBytes,
  config: { images: [{ location: resource.image, arch: resource.arch }], mounts: [],
    ssh: { forwardAgent: false }, containerd: { user: false, system: false } },
};

function processResult(stdout = new Uint8Array()): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

function createdGuest(request: Parameters<ExecService['run']>[0]): typeof native {
  const args = request.args ?? [];
  const instance = args[args.indexOf('--name') + 1];
  const store = request.env?.LIMA_HOME;
  if (!instance || !store) throw new Error('Native create requires its name and absolute store');
  return { ...native, name: instance, dir: join(store, instance) };
}

async function activatedAction(id: string, exec: Pick<ExecService, 'run'> & Partial<Pick<ExecService, 'spawn'>>, readyDependencies?: readonly string[], dependencyFailure?: Error) {
  const handlers = new Map<string, ActionHandler>();
  // This fixture replaces only the external host registration/services boundary;
  // the real public authoring, native decoder and lifecycle logic stay in use.
  const api = { actions: { register(actionId: string, handler: ActionHandler) {
    handlers.set(actionId, handler); return { dispose() {} };
  } } } as unknown as PluginApi;
  await LIMA_PLUGIN.activate(api);
  const handler = handlers.get(id);
  if (!handler) throw new Error(`declared action ${id} was not activated`);
  const context = { invokedAtMs: 123, signal: new AbortController().signal,
    services: { exec, managedServices: { dependencies: { status: async (dependencyId: string): Promise<ManagedDependencyStatus> => {
      if (dependencyFailure) throw dependencyFailure;
      return readyDependencies !== undefined && !readyDependencies.includes(dependencyId)
        ? { state: 'missing', id: dependencyId, supported: true } : { state: 'ready', id: dependencyId,
        version: dependencyId === 'lima-cli' ? '2.1.0' : '9.2.0', sourceId: 'system',
        executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: dependencyId } },
      }; } } } },
  } as unknown as PluginInvocationContext;
  return { handler, context };
}

// The native filesystem store contract is POSIX; Lima supports Darwin and Linux hosts.
describe.skipIf(process.platform === 'win32')('activated public Lima actions', () => {
  it('recovers an absent credential-free Prepare through the public role', async () => {
    const exec = { run: async () => processResult() };
    const { handler, context } = await activatedAction('prepare-inspect', exec);
    const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
    expect(await handler({ operationId: 'prepare-test', launch: { ...identity,
      memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } }, context)).toEqual({ kind: 'absent' });
  });
  it.each(['check', 'options', 'acquire', 'reconcile', 'inspect', 'resize', 'power', 'destroy', 'put-file'])(
    'retains authored failures from dependency acquisition and native execution in %s', async action => {
      const failure = new PluginError({ code: 'credential_unavailable', message: 'Repair the native service.',
        remediation: { kind: 'retry' },
        failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: 'EACCES', httpStatus: 403 } });
      const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
      const inputs: Record<string, unknown> = {
        check: {}, options: { image: 'template:ubuntu', arch: resource.arch },
        acquire: { managedId: 'retained', launch: { ...identity, memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } },
        reconcile: { nativeOperation: resource },
        inspect: { resource }, resize: { resource, size: { cpuCores: 4 } }, power: { resource, intent: 'start' },
        destroy: { resource }, 'put-file': { resource, guestPath: '/tmp/bootstrap', bytesBase64: 'YQ==' },
      };
      const exec = { run: async (): Promise<PluginProcessResult> => { throw failure; } };
      for (const dependencyFailure of [failure, undefined]) {
        const { handler, context } = await activatedAction(action, exec, undefined, dependencyFailure);
        await expect(handler(inputs[action], context)).rejects.toBe(failure);
      }
    });

  it.each([
    { hostOS: 'darwin', arch: 'aarch64', vmType: 'vz' },
    { hostOS: 'linux', arch: 'x86_64', vmType: 'qemu' },
  ])('creates and recovers one socket-safe native identity for a long selected persistent store on $hostOS', async ({ hostOS, arch, vmType }) => {
    const store = join(testDirectory, 'long-selected-persistent-store-'.repeat(5));
    let created: typeof native | undefined;
    let present = false;
    let running = false;
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const command = request.args?.[0];
      if (command === 'info') return processResult(new TextEncoder().encode(JSON.stringify({
        hostOS, hostArch: arch, vmTypes: [vmType],
      })));
      expect(request.cwd).not.toBe(store);
      expect(request.env).toEqual({ LIMA_HOME: request.cwd });
      if (command === 'create') { present = true; created = createdGuest(request); }
      if (command === 'restart') running = true;
      if (command === 'delete') present = false;
      return processResult(new TextEncoder().encode(command === 'list' && present
        ? JSON.stringify({ ...created, arch, vmType, config: { ...native.config, images: [{ location: resource.image, arch }] },
          status: running ? 'Running' : 'Stopped' }) : ''));
    } };
    const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
    const launch = { ...identity, store, arch, vmType, memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 };
    const acquire = await activatedAction('acquire', exec);
    const result = LIMA_RECONCILIATION_SCHEMAS.result.parse(await acquire.handler({ managedId: 'test-row', launch }, acquire.context));
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') throw new Error('Expected native acquisition');
    const acquired = LimaResourceSchema.parse(result.resource.value);
    expect(join(acquired.store, acquired.instance)).toBe(created?.dir);
    expect(Buffer.byteLength(`${acquired.store}/${acquired.instance}/ssh.sock.1234567890123456`))
      .toBeLessThan(process.platform === 'linux' ? 108 : 104);
    const reconcile = await activatedAction('reconcile', exec);
    expect(await reconcile.handler({ correlation: { managedId: 'test-row', launch } }, reconcile.context))
      .toMatchObject({ kind: 'bound', resource: { value: acquired } });
    const destroy = await activatedAction('destroy', exec);
    expect(await destroy.handler({ resource: acquired }, destroy.context)).toEqual({ kind: 'confirmed' });
  });

  it('resizes through the declared native role and publishes inspected physical dimensions', async () => {
    let cpus = resource.cpus;
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      if (request.args?.[0] === 'edit') cpus = Number(request.args[request.args.indexOf('--cpus') + 1]);
      return processResult(new TextEncoder().encode(request.args?.[0] === 'list'
        ? JSON.stringify({ ...native, status: 'Stopped', cpus }) : ''));
    } };
    const services = { exec, managedServices: { dependencies: { status: async (id: string) => ({ state: 'ready',
      executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } } }) } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN, services });
    try {
      expect(await kit.invokeAction('resize', { resource, size: { cpuCores: 4 } }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(await kit.invokeAction('inspect', { resource }, { surface: 'plugin' })).toMatchObject({ size: {
        cpuCores: 4, memoryBytes: resource.memoryBytes, diskBytes: resource.diskBytes,
      } });
    } finally { await kit.dispose(); }
  });

  it.each([
    { image: 'template:ubuntu', title: 'ubuntu.img' },
    { image: 'file:///srv/images/ubuntu.img', title: 'ubuntu.img' },
  ])('returns valid options for the captured Linux QEMU recipe with image $image', async ({ image, title }) => {
    const info = { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], limaHome: '/home/happier/.lima' };
    const exec: Pick<ExecService, 'run'> = { run: async request => processResult(new TextEncoder().encode(
      request.args?.[0] === 'info' ? JSON.stringify(info)
        : request.args?.[0] === 'template' ? JSON.stringify([{ arch: 'x86_64', location: 'https://example.test/ubuntu.img' }])
          : 'limactl version 2.2.1',
    )) };
    const { handler, context } = await activatedAction('options', exec);
    const recipe = { store: info.limaHome, image, arch: 'x86_64', vmType: 'qemu',
      cpus: 2, memoryGiB: 1, diskGiB: 10, mounts: [] };
    const options = MachineProvisionerOptionsResultV1Schema.parse(await handler(recipe, context));
    const resolvedImage = image.startsWith('template:') ? 'https://example.test/ubuntu.img' : image;
    expect(options.base).toMatchObject({ launch: { ...recipe, image: resolvedImage }, available: true, guestPlatform: 'linux' });
    expect(options.dimensions.image).toEqual([]);
    expect(options.base?.nativeFacts?.image).toEqual({ id: resolvedImage, title,
      ...(image.startsWith('template:') ? { description: 'example.test' } : {}) });
  });

  it.each(['failed', 'unconfirmed'] as const)('retains native startup uncertainty through acquisition without leaking private output (%s)', async outcome => {
    let present = false;
    let created: typeof native | undefined;
    const calls: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])]; calls.push(args);
      if (args[0] === 'info') return processResult(new TextEncoder().encode(JSON.stringify({
        hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz', 'qemu'],
      })));
      if (args[0] === 'create') { present = true; created = createdGuest(request); }
      if (args[0] === 'restart' && outcome === 'failed') return { ...processResult(),
        termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
        stderr: new TextEncoder().encode('failed to open "/private/secret/image": no such file or directory; token=private-token'),
      };
      return processResult(new TextEncoder().encode(args[0] === 'list' && present
        ? JSON.stringify({ ...created, status: 'Stopped' }) : ''));
    } };
    const { handler, context } = await activatedAction('acquire', exec);
    const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
    const result = await handler({ managedId: 'test-row', launch: { ...identity,
      memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } }, context);
    expect(result).toMatchObject({ kind: 'unknown', recovery: { reference: created?.dir,
      reason: outcome === 'failed' ? 'lima_start_failed' : 'lima_start_unconfirmed' },
      ...(outcome === 'failed' ? { nativeCause: {
      localCause: 'native_command_failed', command: 'restart', exitCode: 1,
      stderr: expect.stringContaining('no such file or directory'),
    } } : {}) });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('/private/secret');
    expect(calls.filter(args => args[0] === 'restart')).toHaveLength(1);
    expect(calls.some(args => args[0] === 'delete')).toBe(false);
  });

  it.each(['absent', 'unavailable'] as const)('retains the failed-create cause when the following native observation is %s', async observation => {
    let issued = false;
    const calls: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])]; calls.push(args);
      if (args[0] === 'info') return processResult(new TextEncoder().encode(JSON.stringify({
        hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz'],
      })));
      if (args[0] === 'create') {
        issued = true;
        return { ...processResult(), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
          stderr: new TextEncoder().encode('instance name `happier-test` too long: `/private/secret/ssh.sock.1234567890123456` must be less than UNIX_PATH_MAX=108 characters, but is 126; token=private-token') };
      }
      if (issued && observation === 'unavailable') return { ...processResult(),
        termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
        stderr: new TextEncoder().encode('inspection unavailable'),
      };
      return processResult();
    } };
    const { handler, context } = await activatedAction('acquire', exec);
    const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
    const result = LIMA_RECONCILIATION_SCHEMAS.result.parse(await handler({ managedId: 'test-row', launch: { ...identity,
      memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } }, context));
    expect(result).toMatchObject({ kind: 'unknown', recovery: { reason: 'lima_create_failed' }, nativeCause: {
      localCause: 'native_command_failed', command: 'create', exitCode: 1, stderr: expect.stringContaining('UNIX_PATH_MAX=108'),
    } });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('/private/secret');
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(1);
    expect(calls.some(args => args[0] === 'delete' || args[0] === 'restart')).toBe(false);
  });

  it('binds the exact observed guest after a failed create reply without allocating again', async () => {
    let issued = false;
    const calls: string[][] = [];
    let created: typeof native | undefined;
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])]; calls.push(args);
      if (args[0] === 'info') return processResult(new TextEncoder().encode(JSON.stringify({
        hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz'],
      })));
      if (args[0] === 'create') {
        issued = true;
        created = createdGuest(request);
        return { ...processResult(), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
          stderr: new TextEncoder().encode('create response unavailable') };
      }
      return processResult(new TextEncoder().encode(issued ? JSON.stringify(created) : ''));
    } };
    const { handler, context } = await activatedAction('acquire', exec);
    const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
    const result = LIMA_RECONCILIATION_SCHEMAS.result.parse(await handler({ managedId: 'test-row', launch: { ...identity,
      memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } }, context));
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') throw new Error('Expected native acquisition');
    const acquired = LimaResourceSchema.parse(result.resource.value);
    expect(join(acquired.store, acquired.instance)).toBe(created?.dir);
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(1);
    expect(calls.some(args => args[0] === 'delete' || args[0] === 'restart')).toBe(false);
  });

  it('keeps a successful create with unreadable followup unknown without inventing a create failure', async () => {
    let issued = false;
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      if (request.args?.[0] === 'info') return processResult(new TextEncoder().encode(JSON.stringify({
        hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz'],
      })));
      if (request.args?.[0] === 'create') { issued = true; return processResult(); }
      return issued ? { ...processResult(), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
        stderr: new TextEncoder().encode('inspection unavailable') } : processResult();
    } };
    const { handler, context } = await activatedAction('acquire', exec);
    const { memoryBytes, diskBytes, instance: _instance, ...identity } = resource;
    const result = LIMA_RECONCILIATION_SCHEMAS.result.parse(await handler({ managedId: 'test-row', launch: { ...identity,
      memoryGiB: memoryBytes / 1024 ** 3, diskGiB: diskBytes / 1024 ** 3 } }, context));
    expect(result).toMatchObject({ kind: 'unknown', recovery: { reason: 'LIMA_ACQUIRE_UNKNOWN' } });
    expect(result).not.toHaveProperty('nativeCause');
  });

  it('keeps native defaults when Lima reports inherited images instead of inline images', async () => {
    // Relevant fields captured from nl3 `limactl info`, v2.2.1, 2026-10-31.
    // info loads defaults without embedding base templates, so images and vmType are absent.
    const info = {
      version: 'v2.2.1', hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], limaHome: '/home/happier/.lima',
      defaultTemplate: { base: [{ url: 'template:_images/ubuntu' }, { url: 'template:_default/mounts' }],
        minimumLimaVersion: '2.0.0', os: 'Linux', arch: 'x86_64', cpus: 4, memory: '4GiB', disk: '100GiB' },
    };
    const images = [
      { arch: 'aarch64', location: 'https://example.test/ubuntu-arm64.img' },
      { arch: 'x86_64', location: 'https://example.test/ubuntu-amd64.img' },
    ];
    const calls: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])];
      calls.push(args);
      return processResult(new TextEncoder().encode(args[0] === 'info' ? JSON.stringify(info)
        : args[0] === 'template' ? JSON.stringify(images) : 'limactl version 2.2.1'));
    } };
    const services = { exec, managedServices: { dependencies: { status: async (id: string): Promise<ManagedDependencyStatus> => ({
      state: 'ready', id, sourceId: 'system', version: '2.2.1',
      executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } },
    }) } } } satisfies PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN, services });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
      expect(options.base?.launch).toEqual({ store: '/home/happier/.lima', image: images[1].location, arch: 'x86_64', vmType: 'qemu',
        cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] });
      expect(options.dimensions.size[0]?.nativeFacts?.size).toMatchObject({ cpuCores: 4,
        memoryBytes: 4 * 1024 ** 3, diskBytes: 100 * 1024 ** 3 });
      // The size row names the fields it sizes (as Cua's does), so the configurator draws them as its Size section.
      expect(options.dimensions.size[0]?.assignments).toEqual([{ path: 'cpus', value: 4 }, { path: 'memoryGiB', value: 4 },
        { path: 'diskGiB', value: 100 }]);
      expect(options.dimensions.image).toEqual([]);
      expect(options.base?.nativeFacts?.image?.id).toBe(images[1].location);
      expect(LimaLaunchSchema.safeParse(options.base?.launch).success).toBe(true);
      expect(projectMachineProvisionerSelectionV1({ options, selection: { size: options.dimensions.size[0]?.id,
        image: options.dimensions.image[0]?.id }, launchSchema: LimaLaunchSchema.jsonSchema }).kind).toBe('ready');
      expect(calls.filter(args => args[0] === 'info')).toHaveLength(1);
      const image = 'https://example.test/reviewed-ubuntu.img';
      const edited = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', { image, cpus: 2 }, { surface: 'plugin' }));
      expect(edited.base?.launch).toMatchObject({ image, cpus: 2, store: info.limaHome, memoryGiB: 4, diskGiB: 100 });
      expect(projectMachineProvisionerSelectionV1({ options: edited,
        selection: { size: edited.dimensions.size[0]?.id, image: edited.dimensions.image[0]?.id },
        launchSchema: LimaLaunchSchema.jsonSchema })).toMatchObject({ kind: 'ready' });
      expect(calls.filter(args => args[0] === 'template')).toEqual([
        ['template', 'yq', 'template:default', '.images | to_json'],
      ]);
    } finally { await kit.dispose(); }
  });

  it('opens an untouched configuration from the controller native defaults and preserves explicit edits', async () => {
    const calls: string[][] = [];
    const image = 'https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img';
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])];
      calls.push(args);
      return processResult(new TextEncoder().encode(args[0] === 'info' ? JSON.stringify({
        hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], limaHome: '/srv/custom-lima',
        defaultTemplate: { cpus: 6, memory: '8GiB', disk: '40GiB', images: [{ arch: 'x86_64', location: image }] },
      }) : 'limactl version 2.1.0'));
    } };
    const services = { exec, managedServices: { dependencies: { status: async (id: string): Promise<ManagedDependencyStatus> => ({
      state: 'ready', id, sourceId: 'system', version: '2.1.0',
      executable: { kind: 'managedDependency', id: { pluginId: LIMA_PLUGIN.manifest.id, localId: id } },
    }) } } } satisfies PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN, services });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
      expect(options.base?.launch).toEqual({ store: '/srv/custom-lima', image, arch: 'x86_64', vmType: 'qemu',
        cpus: 6, memoryGiB: 8, diskGiB: 40, mounts: [] });
      const projection = projectMachineProvisionerSelectionV1({ options, selection: { size: options.dimensions.size[0]?.id,
        image: options.dimensions.image[0]?.id }, launchSchema: LimaLaunchSchema.jsonSchema });
      expect(projection).toMatchObject({ kind: 'ready', launch: options.base?.launch });
      expect(calls.filter(args => args[0] === 'info')).toHaveLength(1);
      const edited = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', { cpus: 3, store: '/srv/other-lima' }, { surface: 'plugin' }));
      expect(edited.base?.launch).toMatchObject({ cpus: 3, store: '/srv/other-lima', image, memoryGiB: 8 });
      expect(calls.every(args => args[0] === 'info' || args[0] === '--version')).toBe(true);
    } finally { await kit.dispose(); }
  });

  it('reads old launch names through the stored projection while retaining the generated resource identity', async () => {
    const { instance: _instance, memoryBytes: _memory, diskBytes: _disk, ...identity } = resource;
    const launch = { ...identity, memoryGiB: 4, diskGiB: 20 };
    const stored = await prepareMachineProvisionerStoredSchemas({ launch: LimaLaunchSchema, resource: LimaResourceSchema });
    expect(stored.launchStored.parse({ ...launch, instance: 'old-user-choice' })).toEqual(launch);
    expect(stored.resourceStored.parse(resource)).toEqual(resource);
    expect(LimaLaunchSchema.safeParse({ ...launch, instance: 'old-user-choice' }).success).toBe(false);
  });
  it('never grants a managed row custody of the matching pre-existing display-name guest', async () => {
    const { instance: _instance, memoryBytes: _memory, diskBytes: _disk, ...identity } = resource;
    const launch = { ...identity, memoryGiB: 4, diskGiB: 20 };
    const effects: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])];
      if (args[0] === 'info') return processResult(new TextEncoder().encode(JSON.stringify({ hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz'] })));
      if (args[0] !== 'list') effects.push(args);
      return processResult(new TextEncoder().encode(JSON.stringify(native)));
    } };
    const { handler, context } = await activatedAction('acquire', exec);
    for (const managedId of ['first-row', 'second-row']) {
      const result = LIMA_RECONCILIATION_SCHEMAS.result.parse(await handler({ managedId, launch }, context));
      expect(result).not.toMatchObject({ kind: 'bound', resource: { value: resource } });
    }
    expect(effects).toEqual([]);
  });
  it('creates separate row-owned guests from the offered recipe and never adopts an existing guest', async () => {
    const { instance: _instance, memoryBytes: _memory, diskBytes: _disk, ...identity } = resource;
    const launch = { ...identity, memoryGiB: 4, diskGiB: 20 };
    const guests = new Map([[resource.instance, native]]);
    const effects: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])];
      if (args[0] === 'info' || args[0] === '--version') {
        expect(request.env).toBeUndefined();
        expect(request.cwd).toBeUndefined();
      } else {
        expect(request.cwd).toEqual(expect.any(String));
        expect(request.env?.LIMA_HOME).toEqual(expect.any(String));
        expect(resolve(request.cwd!, request.env!.LIMA_HOME!)).toBe(request.cwd);
      }
      if (args[0] === '--version') return processResult(new TextEncoder().encode('limactl version 2.1.0'));
      if (args[0] === 'info') return processResult(new TextEncoder().encode(JSON.stringify({ hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz'] })));
      if (args[0] === 'list') {
        const guest = guests.get(args.at(-1)!);
        return processResult(new TextEncoder().encode(guest ? JSON.stringify(guest) : ''));
      }
      effects.push(args);
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1];
        // Lima v2.1.0 pkg/identifiers/validate.go and dirnames/dirnames.go:
        // separators must be single and internal; mixed case is accepted.
        if (name.length > 76 || !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u.test(name)) {
          return { ...processResult(), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } } };
        }
        expect(guests.has(name)).toBe(false);
        guests.set(name, { ...native, name, dir: `${request.cwd}/${name}` });
      } else if (args[0] === 'delete') guests.delete(args.at(-1)!);
      else if (args[0] === 'stop' || args[0] === 'restart') {
        const guest = guests.get(args.at(-1)!)!;
        guests.set(guest.name, { ...guest, status: args[0] === 'stop' ? 'Stopped' : 'Running' });
      }
      return processResult();
    } };
    const invoke = async (id: string, input: unknown) => {
      const action = await activatedAction(id, exec);
      return action.handler(input, action.context);
    };
    const options = MachineProvisionerOptionsResultV1Schema.parse(await invoke('options', launch));
    const projected = projectMachineProvisionerSelectionV1({ options,
      selection: { size: options.dimensions.size[0]?.id, image: options.dimensions.image[0]?.id }, launchSchema: LimaLaunchSchema.jsonSchema });
    expect(projected.kind).toBe('ready');
    if (projected.kind !== 'ready') throw new Error('Expected a complete reviewed Lima launch');
    const offered = LimaLaunchSchema.parse(projected.launch);
    expect(offered).toEqual(launch);
    const firstId = 'opaque-row-1';
    const acquire = async (managedId: string) => LIMA_RECONCILIATION_SCHEMAS.result.parse(await invoke('acquire', { managedId, launch: offered }));
    const first = await acquire(firstId);
    const second = await acquire('opaque row / B?');
    expect(first.kind).toBe('bound');
    expect(second.kind).toBe('bound');
    if (first.kind !== 'bound' || second.kind !== 'bound') throw new Error('expected native creation');
    const firstResource = LimaResourceSchema.parse(first.resource.value);
    const secondResource = LimaResourceSchema.parse(second.resource.value);
    expect(guests.get(firstResource.instance)?.dir).toBe(join(firstResource.store, firstResource.instance));
    expect(guests.get(secondResource.instance)?.dir).toBe(join(secondResource.store, secondResource.instance));
    expect(firstResource.instance).not.toBe(resource.instance);
    expect(secondResource.instance).not.toBe(resource.instance);
    expect(firstResource.instance).not.toBe(secondResource.instance);
    expect(effects.filter(args => args[0] === 'create')).toHaveLength(2);
    expect(await acquire(firstId)).toMatchObject({ kind: 'rejected' });
    expect(await invoke('reconcile', { correlation: { managedId: firstId, requestId: 'retry', launch: offered } }))
      .toEqual(first);
    expect(await invoke('bootstrap', { resource: firstResource })).toMatchObject({ kind: 'native' });
    expect(await invoke('power', { resource: firstResource, intent: 'stop' })).toEqual({ kind: 'confirmed' });
    expect(await invoke('power', { resource: firstResource, intent: 'start' })).toEqual({ kind: 'confirmed' });
    expect(await invoke('destroy', { resource: firstResource })).toEqual({ kind: 'confirmed' });
    expect(guests.has(firstResource.instance)).toBe(false);
    expect(guests.get(resource.instance)).toEqual(native);
    expect(guests.has(secondResource.instance)).toBe(true);
    expect(effects.filter(args => args[0] === 'create')).toHaveLength(2);
    expect(effects.filter(args => args[0] !== 'create').every(args => args.at(-1) === firstResource.instance)).toBe(true);
  });
  it('delivers shared-admitted exec bytes and rejects malformed input before native IO', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.args?.[0] === 'list'
        ? processResult(new TextEncoder().encode(JSON.stringify(native))) : processResult();
    } };
    const { context } = await activatedAction('exec', exec);
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN,
      services: context.services as unknown as PluginTestServicesFixture });
    try {
      await expect(kit.invokeAction('exec', { resource, argv: ['cat'], inputBase64: 'AA==\n' }, { surface: 'plugin' }))
        .rejects.toThrow();
      expect(requests).toEqual([]);
      expect(await kit.invokeAction('exec', { resource, argv: ['cat'], inputBase64: 'AB==' }, { surface: 'plugin' }))
        .toMatchObject({ stdoutBase64: '', stderrBase64: '' });
      const shell = requests.find(request => request.args?.[0] === 'shell');
      expect(shell?.stdin && Array.from(shell.stdin)).toEqual([0]);
      expect(requests.filter(request => request.stdin !== undefined)).toEqual([shell]);
    } finally { await kit.dispose(); }
  });
  it('carries the stream role as one guest shell channel process of the invocation', async () => {
    const spawned: unknown[] = [];
    const termination = { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'abort' as const } };
    const exec: Pick<ExecService, 'run' | 'spawn'> = {
      run: async () => processResult(new TextEncoder().encode(JSON.stringify(native))),
      spawn: async (request, options) => {
        spawned.push({ args: request.args, outputDelivery: options?.outputDelivery });
        return { waitForExit: async () => termination, dispose: async () => undefined } as never;
      },
    };
    const { context } = await activatedAction('stream', exec);
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN,
      services: context.services as unknown as PluginTestServicesFixture });
    try {
      expect(await kit.invokeAction('stream', { resource, argv: ['hshim', 'attach', '--socket', '/s'] }, { surface: 'plugin' }))
        .toEqual({ termination });
      expect(spawned).toEqual([{ args: ['shell', '--workdir=/', resource.instance, '--', 'hshim', 'attach', '--socket', '/s'],
        outputDelivery: 'invocation' }]);
    } finally { await kit.dispose(); }
  });
  it('keeps retained native roles usable after the owner changes CPU sizing', async () => {
    let present = true;
    let status = 'Running';
    const effects: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      const args = [...(request.args ?? [])];
      expect(request.env?.LIMA_HOME).toEqual(expect.any(String));
      expect(resolve(request.cwd!, request.env!.LIMA_HOME!)).toBe(resource.store);
      expect(request.cwd).toBe(resource.store);
      if (args[0] !== 'list') effects.push(args);
      if (args[0] === 'stop') status = 'Stopped';
      if (args[0] === 'delete') present = false;
      return processResult(new TextEncoder().encode(present ? JSON.stringify({ ...native, cpus: 6, status }) : ''));
    } };
    const { context } = await activatedAction('inspect', exec);
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN,
      services: context.services as unknown as PluginTestServicesFixture });
    try {
      expect(await kit.invokeAction('inspect', { resource }, { surface: 'plugin' }))
        .toMatchObject({ availability: 'present', power: 'running' });
      expect(await kit.invokeAction('bootstrap', { resource }, { surface: 'plugin' })).toMatchObject({ kind: 'native' });
      expect(await kit.invokeAction('power', { resource, intent: 'stop' }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(await kit.invokeAction('destroy', { resource }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(effects).toEqual([['stop', resource.instance], ['delete', '--force', resource.instance]]);
    } finally { await kit.dispose(); }
  });
  it('recovers a retained exact guest without renaming it or a native effect and refuses a foreign name', async () => {
    let observed: typeof native | null = native;
    const reads: string[][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      reads.push([...(request.args ?? [])]);
      return processResult(new TextEncoder().encode(observed ? JSON.stringify(observed) : ''));
    } };
    const { handler, context } = await activatedAction('reconcile', exec);
    const input = { nativeOperation: resource };
    expect(await handler(input, context)).toMatchObject({ kind: 'bound', resource: { value: resource } });
    observed = { ...native, name: 'another-row' };
    expect(await handler(input, context)).toMatchObject({ kind: 'unknown', recovery: { reason: 'LIMA_IDENTITY_MISMATCH' } });
    observed = null;
    const recovered = await handler(input, context);
    expect(recovered).toMatchObject({ kind: 'rejected', code: 'managed_not_found' });
    const destroy = await activatedAction('destroy', exec);
    expect(await destroy.handler({ nativeOperation: resource }, destroy.context)).toEqual({ kind: 'confirmed' });
    expect(reads.every(args => args[0] === 'list')).toBe(true);
  });
  it('admits the full cold manifest through canonical SDK manifest validation', () => {
    expect(parsePluginManifest(LIMA_PLUGIN.manifest)).toMatchObject({ ok: true });
  });

  it('offers the Linux VM as controller-local Session placement with native sandbox support', () => {
    expect(LIMA_PLUGIN.manifest.contributes.machineProvisioners).toMatchObject([{
      id: 'lima', sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: true },
    }]);
  });

  it('uses declared read-only system dependency readiness for Linux native availability', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async (request) => processResult(new TextEncoder().encode(
      request.args?.[0] === '--version' ? 'limactl version 2.1.0'
        : JSON.stringify({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] }))) };
    const unavailable = await activatedAction('check', exec, ['lima-cli', 'qemu-x86-64']);
    expect(await unavailable.handler({}, unavailable.context)).toMatchObject({ available: false, code: 'qemu_unavailable',
      status: { key: 'machineLima.presentation.qemu_unavailable' } });
    const ready = await activatedAction('check', exec, ['lima-cli', 'qemu-x86-64', 'qemu-img']);
    expect(await ready.handler({}, ready.context)).toMatchObject({ available: true,
      prerequisites: [{ requirement: { id: { localId: 'qemu-x86-64' } }, status: 'available' },
        { requirement: { id: { localId: 'qemu-img' } }, status: 'available' }] });
  });

  it('says a missing Lima install is an absent prerequisite, not a failed check', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async () => processResult(new Uint8Array()) };
    const missing = await activatedAction('check', exec, []);
    expect(await missing.handler({}, missing.context)).toMatchObject({ available: false, code: 'lima_unavailable',
      prerequisites: [{ requirement: { id: { localId: 'lima-cli' } }, status: 'unavailable',
        repairAction: { action: { pluginId: LIMA_PLUGIN.manifest.id, localId: 'install' }, input: {} } }] });
  });

  it('delegates installation to the dependency owner and preserves its refusal', async () => {
    const ensured: string[] = [];
    const services = { managedServices: { dependencies: {
      ensure: async (id: string) => {
        ensured.push(id);
        throw new PluginError({ code: 'plugin_managed_dependency_aborted', message: 'Installation cancelled' });
      },
    } } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: LIMA_PLUGIN.manifest, module: LIMA_PLUGIN, services });
    try {
      await expect(kit.invokeAction('install', {}, { surface: 'plugin' }))
        .rejects.toMatchObject({ code: 'plugin_managed_dependency_aborted' });
      expect(ensured).toEqual(['lima-cli']);
    } finally { await kit.dispose(); }
  });

  it('preserves binary streams and cancellation while private input stays on native stdin', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const result: PluginProcessResult = { ...processResult(new Uint8Array([255, 0])),
      stderr: new Uint8Array([128]), stdoutTruncated: true,
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } };
    const exec: Pick<ExecService, 'run'> = { run: async (request) => {
      requests.push(request);
      return request.args?.[0] === 'list' ? processResult(new TextEncoder().encode(JSON.stringify(native))) : result;
    } };
    const { handler, context } = await activatedAction('exec', exec);
    const input = new Uint8Array([0, 254, 10]);
    expect(await handler({ resource, argv: ['cat'], inputBase64: Buffer.from(input).toString('base64') }, context)).toEqual({
      termination: result.termination, stdoutBase64: '/wA=', stderrBase64: 'gA==', stdoutTruncated: true, stderrTruncated: false,
    });
    const shell = requests.find((request) => request.args?.[0] === 'shell');
    expect(shell?.stdin && Array.from(shell.stdin)).toEqual(Array.from(input));
    expect(shell?.env?.LIMA_HOME).toEqual(expect.any(String));
    expect(resolve(shell!.cwd!, shell!.env!.LIMA_HOME!)).toBe(resource.store);
    expect(shell?.cwd).toBe(resource.store);
    expect(requests.filter((request) => request.stdin !== undefined)).toEqual([shell]);
  });

  it('does not confirm a private file write when the native process was canceled', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async (request) => request.args?.[0] === 'list'
      ? processResult(new TextEncoder().encode(JSON.stringify(native)))
      : { ...processResult(), termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } } };
    const { handler, context } = await activatedAction('put-file', exec);
    expect(await handler({ resource, guestPath: '/tmp/private-enrollment', bytesBase64: 'AP4K', mode: 384 }, context))
      .toEqual({ kind: 'unknown' });
  });
});


it('declares saved CPU, memory and disk dimensions through the options Action', () => {
  const provisioner = LIMA_PLUGIN.manifest.contributes.machineProvisioners?.find(item => item.id === 'lima');
  expect(provisioner).toBeDefined();
  const options = LIMA_PLUGIN.manifest.contributes.actions?.find(action => action.id === provisioner?.actions.options);
  expect(options?.inputHints?.fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'cpus', role: 'cpu' }),
    expect.objectContaining({ path: 'memoryGiB', role: 'memory' }),
    expect.objectContaining({ path: 'diskGiB', role: 'disk' }),
  ]));
});
