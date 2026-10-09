import { describe, expect, it } from 'vitest';
import type { LimaCommandResult, LimaExecutor } from '@happier-dev/cli-common/machineLima';
import { createLimaProvider } from './provider.js';
import { LimaLaunchSchema } from './schemas.js';

const launch = LimaLaunchSchema.parse({
  instance: 'happier-lima-test', store: '/private/lima-test', image: 'https://example.test/ubuntu.img',
  vmType: 'vz', arch: 'aarch64', cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [],
});
const { memoryGiB, diskGiB, ...identity } = launch;
const resource = { ...identity, memoryBytes: memoryGiB * 1024 ** 3, diskBytes: diskGiB * 1024 ** 3 };
const native = {
  name: launch.instance, dir: `${launch.store}/${launch.instance}`, status: 'Running',
  vmType: launch.vmType, arch: launch.arch, cpus: launch.cpus, memory: resource.memoryBytes, disk: resource.diskBytes,
  config: { images: [{ location: launch.image, arch: launch.arch }], mounts: [], ssh: { forwardAgent: false }, containerd: { user: false, system: false } },
};

function processBoundary(handler: (args: readonly string[], options?: Parameters<LimaExecutor['capture']>[2]) => LimaCommandResult | Promise<LimaCommandResult>,
  info = { hostOS: 'darwin', hostArch: 'aarch64', vmTypes: ['vz', 'qemu'] }) {
  const effects: string[][] = [];
  const capture: LimaExecutor['capture'] = async (_command, args, options) => args[0] === 'info'
    ? { exitCode: 0, out: JSON.stringify(info), err: '' } : handler(args, options);
  const run: LimaExecutor['run'] = async (_command, args, options) => {
    effects.push([...args]);
    return handler(args, options);
  };
  return { executor: { capture, run }, effects };
}

describe('public Lima native leaf', () => {
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

  it('does not advertise a QEMU executable without its native disk-image tool', async () => {
    const { executor } = processBoundary(() => ({ exitCode: 0, out: 'limactl version 2.1.0', err: '' }),
      { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
    expect(await createLimaProvider(executor, 123, async (id) => id === 'qemu-x86-64').check())
      .toMatchObject({ available: false, code: 'qemu_unavailable' });
  });

  it('requires the selected guest architecture QEMU tool before any allocation', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify(native), err: '' }),
      { hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] });
    expect(await createLimaProvider(executor, 123, async (id) => id === 'qemu-x86-64').acquire({ ...launch, vmType: 'qemu' }))
      .toEqual({ kind: 'unknown', recovery: { reference: `${launch.store}/${launch.instance}`, reason: 'qemu_unavailable' } });
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

  it('reconciles lost creation response at the same store/name without allocating again', async () => {
    let present = false;
    const { executor, effects } = processBoundary((args, options) => {
      expect(options?.env?.LIMA_HOME).toBe(launch.store);
      if (args[0] === 'create') { present = true; throw new Error('lost process response'); }
      return { exitCode: 0, out: present ? JSON.stringify(native) : '', err: '' };
    });
    expect(await createLimaProvider(executor).acquire(launch)).toMatchObject({ kind: 'bound', resource: { value: { instance: launch.instance, store: launch.store } } });
    expect(effects.filter((args) => args[0] === 'create')).toHaveLength(1);
    expect(effects.some((args) => args[0] === 'delete')).toBe(false);
  });

  it('retains an allocated guest with mismatched creation facts as unknown, not rejected absence', async () => {
    let present = false;
    const { executor } = processBoundary((args) => {
      if (args[0] === 'create') present = true;
      return { exitCode: 0, out: present ? JSON.stringify({ ...native, vmType: 'qemu' }) : '', err: '' };
    });
    expect(await createLimaProvider(executor).acquire(launch)).toEqual({
      kind: 'unknown', recovery: { reference: `${launch.store}/${launch.instance}`, reason: 'resource_mismatch' },
    });
  });

  it('does not infer absence from a wrong native identity before acquisition', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, name: 'neighbor' }), err: '' }));
    expect(await createLimaProvider(executor).acquire(launch)).toEqual({
      kind: 'unknown', recovery: { reference: `${launch.store}/${launch.instance}`, reason: 'LIMA_IDENTITY_MISMATCH' },
    });
    expect(effects).toEqual([]);
  });

  it('exact delete retains the neighboring VM and waits for confirmed absence', async () => {
    let present = true;
    const { executor, effects } = processBoundary((args, options) => {
      expect(options?.env?.LIMA_HOME).toBe(launch.store);
      if (args[0] === 'delete') {
        expect(args).toEqual(['delete', '--force', launch.instance]);
        present = false;
      }
      return { exitCode: 0, out: present ? JSON.stringify(native) : '', err: '' };
    });
    expect(await createLimaProvider(executor).destroy(resource)).toEqual({ kind: 'confirmed' });
    expect(effects).toEqual([['delete', '--force', launch.instance]]);
  });

  it('refuses a retained resource whose native creation facts changed', async () => {
    const { executor, effects } = processBoundary(() => ({ exitCode: 0, out: JSON.stringify({ ...native, arch: 'x86_64' }), err: '' }));
    expect(await createLimaProvider(executor).power(resource, 'start')).toEqual({ kind: 'refused', code: 'resource_mismatch' });
    expect(effects).toEqual([]);
  });

  it('starts a stopped retained guest through the inspection-only native operation', async () => {
    let running = false;
    const { executor, effects } = processBoundary((args) => {
      if (args[0] === 'restart' || args[0] === 'start') running = true;
      return { exitCode: 0, out: JSON.stringify({ ...native, status: running ? 'Running' : 'Stopped' }), err: '' };
    });
    expect(await createLimaProvider(executor).power(resource, 'start')).toEqual({ kind: 'confirmed' });
    expect(effects).toEqual([['restart', launch.instance]]);
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
