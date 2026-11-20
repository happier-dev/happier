import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { LimaCommandResult, LimaExecutor } from '@happier-dev/plugin-sdk/machine-provisioners';
import { buildCreateArgs, createLimaProvider, limaAcquisitionResource, limaPreparationMessage } from './provider.js';
import { LimaLaunchSchema } from './schemas.js';
import { MACHINE_PROVISIONER_CLOUD_SSH_USER } from '@happier-dev/plugin-sdk/machine-provisioners';
import { MachineProvisionerAcquireResultV1Schema, MachineProvisionerObservationV1Schema,
  MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

const launch = LimaLaunchSchema.parse({
  store: '/private/lima-test', image: 'https://example.test/ubuntu.img',
  vmType: 'vz', arch: 'aarch64', cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [],
});
const { memoryGiB, diskGiB, ...identity } = launch;
const resource = { ...identity, instance: 'happier-lima-test', memoryBytes: memoryGiB * 1024 ** 3, diskBytes: diskGiB * 1024 ** 3 };
const managedId = 'test-row';
const managedInstance = 'happier-424cfeskscqixzgevqcbc981tdeoxvmc20zpn0akjnbxa3dg35';
const native = {
  name: resource.instance, dir: `${resource.store}/${resource.instance}`, status: 'Running',
  vmType: launch.vmType, arch: launch.arch, cpus: launch.cpus, memory: resource.memoryBytes, disk: resource.diskBytes,
  config: { images: [{ location: launch.image, arch: launch.arch }], mounts: [], ssh: { forwardAgent: false }, containerd: { user: false, system: false } },
};

function processBoundary(handler: (args: readonly string[], options?: Parameters<LimaExecutor['capture']>[2]) => LimaCommandResult | Promise<LimaCommandResult>,
  info = { hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz', 'qemu'] }) {
  const effects: string[][] = [];
  const reads: string[][] = [];
  const capture: LimaExecutor['capture'] = async (_command, args, options) => {
    reads.push([...args]);
    return args[0] === 'info' ? { exitCode: 0, out: JSON.stringify(info), err: '' } : handler(args, options);
  };
  const run: LimaExecutor['run'] = async (_command, args, options) => {
    effects.push([...args]);
    return handler(args, options);
  };
  return { executor: { capture, run }, effects, reads };
}

describe('public Lima native leaf', () => {
  it('refuses host-folder mounts before native VM creation', async () => {
    const boundary = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    const provider = createLimaProvider(boundary.executor);
    const requested = { ...launch, mounts: [{ location: '/host/project', mountPoint: '/workspace', writable: true }] };
    await expect(provider.options(requested)).rejects.toThrow();
    await expect(provider.acquire({ managedId, launch: requested })).rejects.toThrow();
    expect(boundary.effects).toEqual([]);
  });
  it('refuses legacy mounted guest access and restart while preserving exact inspection and deletion', async () => {
    const mounts = [{ location: '/host/project', mountPoint: '/workspace', writable: true }];
    const legacy = { ...resource, mounts };
    let present = true;
    const boundary = processBoundary(args => {
      if (args[0] === 'delete') present = false;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, config: { ...native.config, mounts } }) : '', err: '' };
    });
    const provider = createLimaProvider(boundary.executor);
    await expect(provider.bootstrap(legacy)).rejects.toMatchObject({ code: 'native_resource_unavailable' });
    await expect(provider.exec(legacy, ['sh'])).rejects.toMatchObject({ code: 'native_resource_unavailable' });
    await expect(provider.stream(legacy, ['sh'])).rejects.toMatchObject({ code: 'native_resource_unavailable' });
    await expect(provider.putFile(legacy, '/tmp/file', new Uint8Array())).rejects.toMatchObject({ code: 'native_resource_unavailable' });
    await expect(provider.power(legacy, 'start')).rejects.toMatchObject({ code: 'native_resource_unavailable' });
    expect(boundary.effects).toEqual([]);
    expect(await provider.inspect(legacy)).toMatchObject({ availability: 'present' });
    expect(await provider.destroy(legacy)).toEqual({ kind: 'confirmed' });
  });
  it.each([false, true])('keeps long-store acquisition, recovery and guest lifecycle in one socket-safe native store (prepared=%s)', async prepared => {
    const operationId = 'long-store-base';
    const selected = { ...launch, store: '/home/happier/.happier/qa/mach-i1-account-a-1116/lima',
      ...(prepared ? { preparedBase: { operationId } } : {}) };
    const target = limaAcquisitionResource(selected, managedId);
    const base = limaAcquisitionResource({ ...selected, mounts: [] }, `prepare:${operationId}`);
    expect(target.store).toBe(posix.join(homedir(), '.lima'));
    expect(base.store).toBe(target.store);
    expect(target.instance).not.toBe(base.instance);
    expect(limaAcquisitionResource(selected, managedId)).toEqual(target);
    expect(limaAcquisitionResource({ ...selected, store: `${selected.store}-other` }, managedId).instance).not.toBe(target.instance);
    // Lima 2.2.1 filenames.LongestSock includes OpenSSH's temporary suffix.
    for (const resource of [target, base]) {
      expect(Buffer.byteLength(`${resource.store}/${resource.instance}/ssh.sock.1234567890123456`))
        .toBeLessThan(process.platform === 'linux' ? 108 : 104);
    }
    let present = false;
    let status = 'Stopped';
    const { executor } = processBoundary((args, options) => {
      expect(options?.env?.LIMA_HOME).toBe(target.store);
      expect(options?.cwd).toBe(target.store);
      if (args[0] === 'clone') {
        expect(args.slice(-2)).toEqual([base.instance, target.instance]);
        present = true;
      }
      if (args[0] === 'create') present = true;
      if (args[0] === 'restart') status = 'Running';
      if (args[0] === 'stop') status = 'Stopped';
      if (args[0] === 'delete') present = false;
      const isBase = args.at(-1) === base.instance;
      const resource = isBase ? base : target;
      return { exitCode: 0, out: args[0] === 'list' && (present || isBase) ? JSON.stringify({ ...native,
        name: resource.instance, dir: `${resource.store}/${resource.instance}`, status: isBase ? 'Stopped' : status,
        config: { ...native.config, ...(isBase ? { message: limaPreparationMessage(operationId) } : {}) },
      }) : '', err: '' };
    });
    const provider = createLimaProvider({ ...executor, channel: async (_command, _args, options) => {
      expect(options?.env?.LIMA_HOME).toBe(target.store);
      return 'channel';
    } });
    const acquired = await provider.acquire({ managedId, launch: selected });
    expect(acquired).toMatchObject({ kind: 'bound', resource: { value: target } });
    expect(await provider.reconcile({ managedId, launch: selected })).toMatchObject({ kind: 'bound', resource: { value: target } });
    expect(await provider.exec(target, ['true'])).toMatchObject({ exitCode: 0 });
    expect(await provider.stream(target, ['true'])).toBe('channel');
    expect(await provider.putFile(target, '/tmp/payload', new Uint8Array())).toEqual({ kind: 'written' });
    expect(await provider.power(target, 'stop')).toEqual({ kind: 'confirmed' });
    expect(await provider.power(target, 'start')).toEqual({ kind: 'confirmed' });
    expect(await provider.destroy(target)).toEqual({ kind: 'confirmed' });
  });

  it.each(['exec', 'stream', 'putFile', 'power', 'destroy'] as const)('%s inspects native identity only at the shared effect boundary', async role => {
    let status = 'Running';
    let present = true;
    const { executor, reads } = processBoundary(args => {
      if (args[0] === 'stop') status = 'Stopped';
      if (args[0] === 'delete') present = false;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, status }) : '', err: '' };
    });
    const provider = createLimaProvider({ ...executor, channel: async () => 'channel' });
    if (role === 'exec') expect(await provider.exec(resource, ['true'])).toMatchObject({ exitCode: 0 });
    if (role === 'stream') expect(await provider.stream(resource, ['true'])).toBe('channel');
    if (role === 'putFile') expect(await provider.putFile(resource, '/tmp/test', new Uint8Array())).toEqual({ kind: 'written' });
    if (role === 'power') expect(await provider.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
    if (role === 'destroy') expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(reads.filter(args => args[0] === 'list')).toHaveLength(role === 'power' || role === 'destroy' ? 2 : 1);
  });

  it.each(['absent', 'stopped', 'wrong-store', 'invalid-store', 'no-op-power', 'absent-delete'] as const)(
    'preserves the shared native boundary control: %s', async control => {
      const { executor, reads, effects } = processBoundary(() => ({ exitCode: 0, err: '',
        out: control === 'absent' || control === 'absent-delete' ? '' : JSON.stringify({ ...native,
          ...(control === 'stopped' ? { status: 'Stopped' } : {}),
          ...(control === 'wrong-store' ? { dir: '/other/store/guest' } : {}) }) }));
      const provider = createLimaProvider(executor);
      if (control === 'absent' || control === 'stopped') await expect(provider.exec(resource, ['true']))
        .rejects.toMatchObject({ code: 'LIMA_GUEST_UNAVAILABLE' });
      if (control === 'wrong-store') expect(await provider.power(resource, 'stop'))
        .toMatchObject({ kind: 'refused', code: 'LIMA_IDENTITY_MISMATCH' });
      if (control === 'invalid-store') expect(await provider.power({ ...resource, store: '/private/../lima-test' }, 'stop'))
        .toMatchObject({ code: 'LIMA_INVALID_IDENTITY' });
      if (control === 'no-op-power') expect(await provider.power(resource, 'start')).toEqual({ kind: 'confirmed' });
      if (control === 'absent-delete') expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
      expect(effects).toEqual([]);
      expect(reads.filter(args => args[0] === 'list')).toHaveLength(control === 'invalid-store' ? 0 : 1);
    });

  it('resizes a stopped guest through native edit and observes its actual size', async () => {
    let resized = false;
    const size = { cpuCores: 4, memoryBytes: 8 * 1024 ** 3, diskBytes: 30 * 1024 ** 3 };
    const { executor, effects } = processBoundary(args => {
      if (args[0] === 'edit') resized = true;
      return { exitCode: 0, out: JSON.stringify({ ...native, status: 'Stopped', ...(resized ? {
        cpus: size.cpuCores, memory: size.memoryBytes, disk: size.diskBytes,
      } : {}) }), err: '' };
    });
    const provider = createLimaProvider(executor);
    expect(await provider.resize(resource, size)).toEqual({ kind: 'confirmed' });
    expect(effects).toEqual([['edit', '--tty=false', '--cpus', '4', '--memory', '8', '--disk', '30', resource.instance]]);
    expect(await provider.inspect(resource)).toMatchObject({ size });
  });

  it('refuses disk shrink with its dimension and does not edit the guest', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify(native), err: '' }));
    expect(await createLimaProvider(executor).resize(resource, { diskBytes: 10 * 1024 ** 3 }))
      .toEqual({ kind: 'unsupported', dimension: 'diskBytes', code: 'lima_disk_shrink_unsupported' });
    expect(effects).toEqual([]);
  });

  it('preserves native edit failure instead of confirming a resize', async () => {
    const { executor } = processBoundary(args => args[0] === 'edit'
      ? { exitCode: 1, out: '', err: 'cannot edit' }
      : { exitCode: 0, out: JSON.stringify({ ...native, status: 'Stopped' }), err: '' });
    expect(await createLimaProvider(executor).resize(resource, { cpuCores: 4 }))
      .toMatchObject({ kind: 'unknown', code: 'lima_resize_failed' });
  });

  it('keeps launch choices available after the installed check without probing the version again', async () => {
    let versionReads = 0;
    const { executor } = processBoundary(args => {
      if (args[0] === '--version') {
        versionReads += 1;
        return versionReads === 1 ? { exitCode: 0, out: 'limactl version 2.1.0', err: '' }
          : { exitCode: 1, out: '', err: 'temporary version probe failure' };
      }
      return { exitCode: 0, out: '', err: '' };
    });
    const provider = createLimaProvider(executor);
    expect(await provider.check()).toMatchObject({ available: true });
    expect(await provider.options(launch)).toMatchObject({ base: { available: true, launch } });
    expect(await provider.options({ ...launch, cpus: 4 })).toMatchObject({ base: { available: true, launch: { cpus: 4 } } });
    expect(versionReads).toBe(1);
  });

  it.each(['vz', 'qemu'] as const)('disables automatic guest-to-host forwarding in the generated %s template', vmType => {
    const args = buildCreateArgs({ ...launch, instance: 'happier-port-forward-test', vmType });
    const forwarding = args.find((arg, index) => args[index - 1] === '--set' && arg.startsWith('.portForwards = '));
    expect(forwarding).toBeDefined();
    expect(JSON.parse(forwarding!.slice('.portForwards = '.length))).toEqual([
      { guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', guestPortRange: [1, 65535], ignore: true },
    ]);
  });

  it.each(['vz', 'qemu'] as const)('keeps the generated %s bootstrap sudo grant off the daemon identity', vmType => {
    const args = buildCreateArgs({ ...launch, instance: 'happier-ask-user-test', vmType });
    const assignments = args.filter((_, index) => args[index - 1] === '--set');
    const bootstrapUser = assignments.join(' | ').match(/\.user\.name\s*=\s*("[^"]*")/u);
    // Lima's cloud-init grants NOPASSWD to user.name (host username when omitted).
    // Enrollment creates its separate, protocol-owned `happier` daemon principal.
    expect(bootstrapUser).not.toBeNull();
    expect(JSON.parse(bootstrapUser![1])).toBe(MACHINE_PROVISIONER_CLOUD_SSH_USER);
    expect(JSON.parse(bootstrapUser![1])).not.toBe('happier');
  });

  it.each(['Stopped', 'Broken'])('recovers the exact existing %s guest without allocating or starting it', async status => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, status }), err: '' }));
    expect(await createLimaProvider(executor).reconcile({ resource })).toMatchObject({ kind: 'bound', resource: { value: resource } });
    expect(effects).toEqual([]);
  });

  it('settles an exact acquisition as not created only after a successful empty native read', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    expect(await createLimaProvider(executor).reconcile({ managedId, launch }))
      .toMatchObject({ kind: 'rejected', code: 'managed_not_found' });
    expect(effects).toEqual([]);
  });

  it('refuses an unresolved template selector before allocating a disk-image recipe', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    expect(await createLimaProvider(executor).acquire({ managedId, launch: { ...launch, image: 'template:ubuntu' } }))
      .toMatchObject({ kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'native_options_changed' } });
    expect(effects).toEqual([]);
  });

  it('does not bind a guest when the native start exits successfully but inspection still reports Stopped', async () => {
    let present = false;
    const { executor } = processBoundary(args => {
      if (args[0] === 'create') present = true;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, name: managedInstance,
        dir: `${launch.store}/${managedInstance}`, status: 'Stopped' }) : '', err: '' };
    });
    expect(await createLimaProvider(executor).acquire({ managedId, launch }))
      .toMatchObject({ kind: 'unknown', recovery: { reason: 'lima_start_unconfirmed' } });
  });

  // Lima 2.2.1 info leaves the base templates unresolved (Rerun 59, nl3).
  const inheritedInfo = {
    hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], limaHome: '/home/happier/.lima',
    defaultTemplate: { base: [{ url: 'template:_images/ubuntu' }, { url: 'template:_default/mounts' }],
      cpus: 4, memory: '1GiB', disk: '100GiB' },
  };
  const resolvedImages = [
    { arch: 'x86_64', location: 'https://cloud-images.ubuntu.com/releases/resolute/release-20260927/ubuntu-26.04-server-cloudimg-amd64.img' },
    { arch: 'x86_64', location: 'https://cloud-images.ubuntu.com/releases/resolute/release/ubuntu-26.04-server-cloudimg-amd64.img' },
    { arch: 'aarch64', location: 'https://cloud-images.ubuntu.com/releases/resolute/release-20260927/ubuntu-26.04-server-cloudimg-arm64.img' },
  ];

  it('explains why 1 GiB cannot be reviewed for Create and recommends 4 GiB', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    const options = MachineProvisionerOptionsResultV1Schema.parse(
      await createLimaProvider(executor).options({ ...launch, memoryGiB: 1 }));
    expect(projectMachineProvisionerSelectionV1({ options, launchSchema: LimaLaunchSchema.jsonSchema,
      selection: { size: '2/1/20' } })).toMatchObject({
      kind: 'unavailable', code: 'agent_session_memory_too_small', unavailableReason: {
        code: 'agent_session_memory_too_small',
        status: { params: { measuredPeakGiB: '1.80', minimumGiB: 2, recommendedGiB: 4 } },
      },
    });
  });

  it.each([2, 4, 6])('keeps %s GiB as an explicit, reviewable size', async memoryGiB => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    const requested = { ...launch, memoryGiB };
    const options = await createLimaProvider(executor).options(requested);
    expect(projectMachineProvisionerSelectionV1({ options, launchSchema: LimaLaunchSchema.jsonSchema,
      selection: { size: `2/${memoryGiB}/20` } })).toMatchObject({ kind: 'ready', launch: requested });
  });

  it('rejects a retained 1 GiB recipe at acquisition before native allocation', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    const result = await createLimaProvider(executor).acquire({ managedId, launch: { ...launch, memoryGiB: 1 } });
    expect(MachineProvisionerAcquireResultV1Schema.parse(result)).toEqual({
      kind: 'rejected', code: 'agent_session_memory_too_small',
    });
    expect(effects).toEqual([]);
  });

  it.each(['x86_64', 'aarch64'] as const)('resolves the inherited default image for selected architecture %s with one native read', async arch => {
    const { executor, reads, effects } = processBoundary(args => ({ exitCode: 0,
      out: args[0] === 'template' ? JSON.stringify(resolvedImages) : 'limactl version 2.2.1', err: '' }), inheritedInfo);
    const options = await createLimaProvider(executor, 123, async () => true).options({ arch });
    const image = resolvedImages.find(candidate => candidate.arch === arch)?.location;
    expect(options.base?.launch).toMatchObject({ arch, image, store: inheritedInfo.limaHome,
      cpus: 4, memoryGiB: 4, diskGiB: 100, mounts: [] });
    expect(options.dimensions.image).toEqual([]);
    expect(options.base?.nativeFacts?.image?.id).toBe(image);
    expect(LimaLaunchSchema.safeParse(options.base?.launch).success).toBe(true);
    expect(reads.filter(args => args[0] === 'template')).toEqual([
      ['template', 'yq', 'template:default', '.images | to_json'],
    ]);
    expect(effects).toEqual([]);
  });

  it.each(['explicit', 'inline'] as const)('keeps an %s image without a template expansion read', async source => {
    const image = 'https://example.test/reviewed.img';
    const info = { ...inheritedInfo, defaultTemplate: { ...inheritedInfo.defaultTemplate,
      ...(source === 'inline' ? { images: [{ arch: 'x86_64', location: image }] } : {}) } };
    const { executor, reads } = processBoundary(() => ({ exitCode: 0, out: 'limactl version 2.2.1', err: '' }), info);
    const options = await createLimaProvider(executor, 123, async () => true).options(source === 'explicit' ? { image } : {});
    expect(options.base?.launch).toMatchObject({ image });
    expect(reads.filter(args => args[0] === 'template')).toEqual([]);
  });

  it.each(['exit', 'throw', 'malformed', 'other-arch'] as const)('leaves an unresolved image absent on expansion %s', async failure => {
    const { executor, effects } = processBoundary(args => {
      if (args[0] !== 'template') return { exitCode: 0, out: 'limactl version 2.2.1', err: '' };
      if (failure === 'throw') throw new Error('native expansion failed');
      return { exitCode: failure === 'exit' ? 1 : 0,
        out: failure === 'malformed' ? 'invalid JSON' : JSON.stringify([resolvedImages[2]]), err: '' };
    }, inheritedInfo);
    const options = await createLimaProvider(executor, 123, async () => true).options({});
    expect(options.base?.launch).toMatchObject({ arch: 'x86_64', cpus: 4, memoryGiB: 4, diskGiB: 100 });
    expect(options.base?.launch).not.toHaveProperty('image');
    expect(options.dimensions.image).toEqual([]);
    expect(effects).toEqual([]);
  });

  it.each(['Running', 'Stopped'])('reports retained storage for an exact listed %s guest through the shared observation contract', async status => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, status }), err: '' }));
    const observation = MachineProvisionerObservationV1Schema.parse(await createLimaProvider(executor, 123).inspect(resource));
    expect(observation).toMatchObject({ observedAt: 123, availability: 'present', power: status.toLowerCase(), storage: 'retained' });
    expect(effects).toEqual([]);
  });

  it('does not claim retained storage for an absent guest', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    const observation = MachineProvisionerObservationV1Schema.parse(await createLimaProvider(executor, 123).inspect(resource));
    expect(observation.availability).toBe('absent');
    expect(observation.storage).toBeUndefined();
  });
  it('does not advertise Linux availability from a registered driver without a qualified hypervisor tool', async () => {
    const { executor, effects } = processBoundary((args) => ({ exitCode: 0,
      out: args[0] === '--version' ? 'limactl version 2.1.0' : JSON.stringify({
        hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'], guestAgents: { x86_64: { location: '/share/lima-guestagent' } },
      }), err: '' }), { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
    expect(await createLimaProvider(executor).check()).toMatchObject({ available: false, code: 'qemu_unavailable' });
    expect(effects).toEqual([]);
  });

  it('advertises Linux availability when the native driver and architecture-specific system dependency are ready', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: 'limactl version 2.1.0', err: '' }),
      { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
    const statuses: string[] = [];
    expect(await createLimaProvider(executor, 123, async (id) => { statuses.push(id); return id === 'qemu-x86-64' || id === 'qemu-img'; }).check())
      .toMatchObject({ available: true, prerequisites: [{ status: 'available' }, { status: 'available' }] });
    expect(statuses).toEqual(['qemu-x86-64', 'qemu-img']);
  });

  it('names the reviewed image by its system and source, never by its whole location', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: 'limactl version 2.1.0', err: '' }));
    const query = { ...launch, image: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img?x=1' };
    const { base, dimensions } = await createLimaProvider(executor, 123, async () => true).options(query);
    expect(base).toMatchObject({ guestPlatform: 'linux' });
    expect(dimensions.image).toEqual([]);
    expect(base?.launch).toMatchObject({ image: query.image });
    expect(base?.nativeFacts?.image).toEqual({ id: query.image, title: 'Ubuntu 24.04',
      description: 'cloud-images.ubuntu.com' });
    // A file that names no system and release keeps its file name.
    const custom = await createLimaProvider(executor, 123, async () => true).options({ ...launch, image: 'file:///srv/images/golden.qcow2' });
    expect(custom.base?.nativeFacts?.image).toEqual({ id: 'file:///srv/images/golden.qcow2', title: 'golden.qcow2' });
  });

  it('does not advertise a QEMU executable without its native disk-image tool', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: 'limactl version 2.1.0', err: '' }),
      { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
    expect(await createLimaProvider(executor, 123, async (id) => id === 'qemu-x86-64').check())
      .toMatchObject({ available: false, code: 'qemu_unavailable' });
  });

  it('requires the selected guest architecture QEMU tool before any allocation', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify(native), err: '' }),
      { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
    expect(await createLimaProvider(executor, 123, async (id) => id === 'qemu-x86-64').acquire({ managedId, launch: { ...launch, vmType: 'qemu' } }))
      .toEqual({ kind: 'unknown', recovery: { reference: `${launch.store}/${managedInstance}`, reason: 'qemu_unavailable' } });
    expect(effects).toEqual([]);
  });

  it('requires the host architecture for the native VZ driver before allocation', async () => {
    let present = false;
    const { executor, effects } = processBoundary((args) => {
      if (args[0] === 'create') present = true;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, arch: 'x86_64',
        config: { ...native.config, images: [{ location: launch.image, arch: 'x86_64' }] } }) : '', err: '' };
    });
    expect(await createLimaProvider(executor).acquire({ managedId, launch: { ...launch, arch: 'x86_64' } }))
      .toEqual({ kind: 'unknown', recovery: { reference: `${launch.store}/${managedInstance}`, reason: 'lima_driver_unavailable' } });
    expect(effects).toEqual([]);
  });

  it('returns unavailable on native inspect failure instead of confirmed absence', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 1, out: '', err: 'cannot read store' }));
    expect(await createLimaProvider(executor).inspect(resource)).toMatchObject({ availability: 'unavailable' });
  });

  it('refuses Start for an absent retained guest without creation', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: '', err: '' }));
    expect(await createLimaProvider(executor).power(resource, 'start')).toMatchObject({ kind: 'refused', code: 'MANAGED_LIMA_INSTANCE_ABSENT' });
    expect(effects).toEqual([]);
  });

  it('returns only the qualified private native carrier for an observed running retained guest', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify(native), err: '' }));
    expect(await createLimaProvider(executor).bootstrap(resource)).toEqual({
      kind: 'native', transport: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1 },
    });
    expect(effects).toEqual([]);
  });

  it('settles retained stopped or broken bootstrap without restarting the guest', async () => {
    let status = 'Stopped';
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, status }), err: '' }));
    const provider = createLimaProvider(executor);
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ name: 'PluginError', code: 'native_resource_unavailable' });
    status = 'Running';
    await expect(provider.bootstrap(resource)).resolves.toMatchObject({ kind: 'native' });
    status = 'Broken';
    await expect(provider.bootstrap(resource)).rejects.toMatchObject({ name: 'PluginError', code: 'native_resource_unavailable' });
    expect(effects).toEqual([]);
  });

  it('reconciles lost creation response at the same store/name without allocating again', async () => {
    let present = false;
    const { executor, effects } = processBoundary((args, options) => {
      expect(options?.env?.LIMA_HOME).toBe(launch.store);
      expect(options?.cwd).toBe(launch.store);
      if (args[0] === 'create') { present = true; throw new Error('lost process response'); }
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, name: managedInstance, dir: `${launch.store}/${managedInstance}` }) : '', err: '' };
    });
    expect(await createLimaProvider(executor).acquire({ managedId, launch })).toMatchObject({ kind: 'bound', resource: { value: { instance: managedInstance, store: launch.store } } });
    expect(effects.filter((args) => args[0] === 'create')).toHaveLength(1);
    expect(effects.some((args) => args[0] === 'delete')).toBe(false);
  });

  it('retains an allocated guest with mismatched creation facts as unknown, not rejected absence', async () => {
    let present = false;
    const { executor } = processBoundary((args) => {
      if (args[0] === 'create') present = true;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, name: managedInstance, dir: `${launch.store}/${managedInstance}`, vmType: 'qemu' }) : '', err: '' };
    });
    expect(await createLimaProvider(executor).acquire({ managedId, launch })).toEqual({
      kind: 'unknown', recovery: { reference: `${launch.store}/${managedInstance}`, reason: 'resource_mismatch' },
    });
  });

  it('does not infer absence from a wrong native identity before acquisition', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, name: 'neighbor' }), err: '' }));
    expect(await createLimaProvider(executor).acquire({ managedId, launch })).toEqual({
      kind: 'unknown', recovery: { reference: `${launch.store}/${managedInstance}`, reason: 'LIMA_IDENTITY_MISMATCH' },
    });
    expect(effects).toEqual([]);
  });

  it.each([true, false])('deletes the retained stopped disk or confirms prior absence without a guest process (retained=%s)', async retained => {
    let present = retained;
    const { executor, effects } = processBoundary((args, options) => {
      expect(options?.env?.LIMA_HOME).toBe(launch.store);
      expect(options?.cwd).toBe(launch.store);
      if (args[0] === 'delete') {
        expect(args).toEqual(['delete', '--force', resource.instance]);
        present = false;
      }
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, status: 'Stopped' }) : '', err: '' };
    });
    expect(await createLimaProvider(executor).destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(effects).toEqual(retained ? [['delete', '--force', resource.instance]] : []);
  });

  it('keeps Inspect, bootstrap, Stop and Delete usable after an owner changes native CPU sizing', async () => {
    let present = true;
    let status = 'Running';
    const { executor, effects } = processBoundary((args) => {
      if (args[0] === 'stop') status = 'Stopped';
      if (args[0] === 'delete') present = false;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, cpus: 6, status }) : '', err: '' };
    });
    const provider = createLimaProvider(executor, 123);
    expect(await provider.inspect(resource)).toMatchObject({ availability: 'present', power: 'running' });
    expect(await provider.bootstrap(resource)).toMatchObject({ kind: 'native' });
    expect(await provider.power(resource, 'stop')).toEqual({ kind: 'confirmed' });
    expect(await provider.destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(effects).toEqual([['stop', resource.instance], ['delete', '--force', resource.instance]]);
  });

  it('still refuses another native name after binding', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, name: 'neighbor' }), err: '' }));
    expect(await createLimaProvider(executor).power(resource, 'stop')).toMatchObject({ kind: 'refused', code: 'LIMA_IDENTITY_MISMATCH' });
    expect(await createLimaProvider(executor).destroy(resource)).toMatchObject({ kind: 'refused', code: 'LIMA_IDENTITY_MISMATCH' });
    expect(effects).toEqual([]);
  });

  it('starts a stopped retained guest through the inspection-only native operation', async () => {
    let running = false;
    const { executor, effects } = processBoundary((args) => {
      if (args[0] === 'restart' || args[0] === 'start') running = true;
      return { exitCode: 0, out: JSON.stringify({ ...native, status: running ? 'Running' : 'Stopped' }), err: '' };
    });
    expect(await createLimaProvider(executor).power(resource, 'start')).toEqual({ kind: 'confirmed' });
    expect(effects).toEqual([['restart', resource.instance]]);
  });

  it('does not recreate a guest removed after Start admission but before the native command', async () => {
    let recreated = false;
    const { executor } = processBoundary((args) => {
      if (args[0] === 'start' || args[0] === 'restart') {
        // Native start NAME can create; restart only inspects an existing guest.
        recreated = args[0] === 'start';
        return { exitCode: recreated ? 0 : 1, out: '', err: 'configuration no longer exists' };
      }
      return { exitCode: 0, out: JSON.stringify({ ...native, status: 'Stopped' }), err: '' };
    });
    expect(await createLimaProvider(executor).power(resource, 'start')).toMatchObject({ kind: 'unknown' });
    expect(recreated).toBe(false);
  });
});
