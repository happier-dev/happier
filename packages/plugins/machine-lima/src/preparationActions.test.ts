import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerPreparationBuildResultV1Schema, MachineProvisionerPreparationInspectResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';
import { LimaLaunchSchema } from './machine/schemas.js';

const root = mkdtempSync(join(tmpdir(), 'happier-lima-preparation-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const launch = { store: root, image: 'https://example.test/ubuntu.img', arch: 'x86_64', vmType: 'qemu', cpus: 2, memoryGiB: 2, diskGiB: 10, mounts: [] } as const;
const input = { operationId: 'prepare-one', input: {
  launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'public-release:0.3.0', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
    installScript: 'printf installed', files: [{ path: 'payload.tar.gz', contentsBase64: 'AAECAw==' }] },
  setupScript: 'printf setup',
} };
type Native = { name: string; dir: string; status: string; arch: string; vmType: string; cpus: number; memory: number; disk: number;
  config: { images: { location: string; arch: string }[]; mounts: unknown[]; ssh: { forwardAgent: boolean }; containerd: { user: boolean; system: boolean }; message?: string } };

function boundary(options: { setupExit?: number; setupCancelled?: boolean; editExit?: number; cloneExit?: number; deleteStays?: boolean; failure?: PluginError } = {}) {
  const instances = new Map<string, Native>();
  const calls: { args: readonly string[]; stdin?: Uint8Array }[] = [];
  const result = (out = '', exitCode = 0): PluginProcessResult => ({ stdout: new TextEncoder().encode(out), stderr: new Uint8Array(),
    stdoutTruncated: false, stderrTruncated: false, termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } } });
  // Substitute the external process boundary only; all authoring, role parsing,
  // native decoding, recovery, and acquisition decisions stay real.
  const exec: Pick<ExecService, 'run'> = { run: async request => {
    if (options.failure) throw options.failure;
    const args = request.args ?? [];
    calls.push({ args, ...(request.stdin ? { stdin: request.stdin } : {}) });
    const command = args[0];
    if (command === 'info') return result(JSON.stringify({ hostOS: 'linux', hostArch: 'x86_64', vmTypes: ['qemu'] }));
    if (command === 'list') return result([...instances.values()].filter(i => args.includes(i.name)).map(i => JSON.stringify(i)).join('\n'));
    if (command === 'create') {
      const name = args[args.indexOf('--name') + 1]!;
      instances.set(name, { name, dir: `${root}/${name}`, status: 'Stopped', arch: launch.arch, vmType: launch.vmType,
        cpus: launch.cpus, memory: launch.memoryGiB * 1024 ** 3, disk: launch.diskGiB * 1024 ** 3,
        config: { images: [{ location: launch.image, arch: launch.arch }], mounts: JSON.parse(args.find(arg => arg.startsWith('.mounts = '))!.slice('.mounts = '.length)) as unknown[], ssh: { forwardAgent: false },
          containerd: { user: false, system: false } } });
    }
    if (command === 'clone') {
      if (options.cloneExit) return result('', options.cloneExit);
      const source = instances.get(args.at(-2)!)!;
      if (source.status !== 'Stopped') return result('', 1);
      const name = args.at(-1)!;
      instances.set(name, { ...structuredClone(source), name, dir: `${root}/${name}` });
      instances.get(name)!.config.mounts = JSON.parse(args.find(arg => arg.startsWith('.mounts = '))!.slice('.mounts = '.length)) as unknown[];
    }
    if (command === 'restart') instances.get(args.at(-1)!)!.status = 'Running';
    if (command === 'stop') instances.get(args.at(-1)!)!.status = 'Stopped';
    if (command === 'edit') {
      if (options.editExit) return result('', options.editExit);
      const expression = args[args.indexOf('--set') + 1]!;
      const match = /^\.message = (".*")$/.exec(expression)!;
      instances.get(args.at(-1)!)!.config.message = JSON.parse(match[1]!) as string;
    }
    if (command === 'shell' && request.stdin && new TextDecoder().decode(request.stdin).includes('printf setup')) return options.setupCancelled
      ? { ...result(), termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } } }
      : result('', options.setupExit ?? 0);
    if (command === 'delete' && !options.deleteStays) instances.delete(args.at(-1)!);
    return result();
  } };
  const services = { exec, managedServices: { dependencies: { status: async (id: string) => ({ id, state: 'ready', supported: true,
    version: '2.2.1', sourceId: 'system', executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lima', localId: id } } }) } } } as unknown as PluginTestServicesFixture;
  const kit = () => createPluginTestkit({ manifest: entry.manifest, module: entry.LIMA_PLUGIN, services });
  return { instances, calls, kit };
}

describe.skipIf(process.platform === 'win32')('Lima Prepare through public Actions', () => {
  it('builds a stopped base, recovers it in a fresh runtime, clones it without setup, and deletes only the base', async () => {
    const native = boundary();
    const mountedLaunch = { ...launch, mounts: [{ location: '/host/work', mountPoint: '/workspace', writable: true }] };
    const mountedInput = { ...input, input: { ...input.input, launch: { ...input.input.launch, choices: mountedLaunch } } };
    let kit = await native.kit();
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', mountedInput, { surface: 'plugin' }));
      expect(built.kind).toBe('ready');
      if (built.kind !== 'ready') throw new Error('base did not complete');
      expect([...native.instances.values()].map(i => i.status)).toEqual(['Stopped']);
      expect([...native.instances.values()].map(i => i.config.mounts)).toEqual([[]]);
      expect(native.calls.flatMap(c => c.stdin ? [...c.stdin] : [])).toEqual(expect.arrayContaining([0, 1, 2, 3]));
      expect(native.calls.filter(c => c.args[0] === 'shell').map(c => c.args.join(' ')).join('\n')).not.toContain('printf setup');
      await kit.dispose();
      kit = await native.kit();
      expect(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch: mountedLaunch }, { surface: 'plugin' })).toEqual(built);
      const artifact = built.artifact;
      const choices = LimaLaunchSchema.parse((artifact.value as { launch: unknown }).launch);
      const shellsBefore = native.calls.filter(c => c.args[0] === 'shell').length;
      const acquired = await kit.invokeAction('acquire', { managedId: 'session-one', launch: choices }, { surface: 'plugin' });
      expect(acquired).toMatchObject({ kind: 'bound', resource: { origin: 'created' } });
      expect(native.calls.filter(c => c.args[0] === 'clone')).toHaveLength(1);
      expect(native.calls.filter(c => c.args[0] === 'create')).toHaveLength(1);
      expect(native.calls.filter(c => c.args[0] === 'shell')).toHaveLength(shellsBefore);
      expect([...native.instances.values()].find(i => i.status === 'Running')!.config.mounts).toEqual(mountedLaunch.mounts);
      expect(await kit.invokeAction('prepare-destroy', { artifact }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect([...native.instances.values()].map(i => i.status)).toEqual(['Running']);
      expect(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch: mountedLaunch }, { surface: 'plugin' })).toEqual({ kind: 'absent' });
    } finally { await kit.dispose(); }
  });

  it.each([{ setupExit: 7 }, { setupCancelled: true }, { editExit: 8 }])('never adopts or clones a partial build (%j), retaining cleanup identity', async options => {
    const native = boundary(options), kit = await native.kit();
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      expect(built.kind).toBe('unknown');
      if (built.kind !== 'unknown') throw new Error('failed build lost its identity');
      const inspected = MachineProvisionerPreparationInspectResultV1Schema.parse(await kit.invokeAction('prepare-inspect', { operationId: input.operationId, launch }, { surface: 'plugin' }));
      expect(inspected).toMatchObject({ kind: 'failed', code: 'lima_preparation_incomplete' });
      expect(await kit.invokeAction('prepare-destroy', { nativeOperation: built.nativeOperationRef }, { surface: 'plugin' })).toEqual({ kind: 'confirmed' });
      expect(native.instances.size).toBe(0);
    } finally { await kit.dispose(); }
  });

  it.each(['running', 'partial', 'clone-failed'] as const)('does not silently cold-create when the selected prepared source is %s', async cause => {
    const native = boundary(cause === 'clone-failed' ? { cloneExit: 9 } : {}), kit = await native.kit();
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      if (built.kind !== 'ready') throw new Error('base did not complete');
      const base = [...native.instances.values()][0]!;
      if (cause === 'running') base.status = 'Running';
      if (cause === 'partial') delete base.config.message;
      const choices = LimaLaunchSchema.parse((built.artifact.value as { launch: unknown }).launch);
      expect(await kit.invokeAction('acquire', { managedId: 'session-two', launch: choices }, { surface: 'plugin' })).toMatchObject({
        kind: 'unknown', recovery: { reason: cause === 'clone-failed' ? 'lima_clone_failed' : 'lima_preparation_incomplete' },
      });
      expect(native.calls.filter(c => c.args[0] === 'create')).toHaveLength(1);
      expect(native.instances.size).toBe(1);
    } finally { await kit.dispose(); }
  });

  it('refuses a second build on an existing base and requires observed absence to confirm deletion', async () => {
    const native = boundary({ deleteStays: true }), kit = await native.kit();
    try {
      const built = MachineProvisionerPreparationBuildResultV1Schema.parse(await kit.invokeAction('prepare-build', input, { surface: 'plugin' }));
      if (built.kind !== 'ready') throw new Error('base did not complete');
      expect(await kit.invokeAction('prepare-build', input, { surface: 'plugin' })).toMatchObject({ kind: 'refused', code: 'lima_preparation_exists' });
      expect(native.calls.filter(c => c.args[0] === 'create')).toHaveLength(1);
      expect(await kit.invokeAction('prepare-destroy', { artifact: built.artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'pending' });
      const base = [...native.instances.values()][0]!;
      base.config.images = [{ location: 'unrelated-user-disk', arch: launch.arch }];
      const deletes = native.calls.filter(c => c.args[0] === 'delete').length;
      expect(await kit.invokeAction('prepare-destroy', { artifact: built.artifact }, { surface: 'plugin' })).toMatchObject({ kind: 'unknown', code: 'resource_mismatch' });
      expect(native.calls.filter(c => c.args[0] === 'delete')).toHaveLength(deletes);
    } finally { await kit.dispose(); }
  });

  it.each(['prepare-build', 'prepare-inspect', 'prepare-destroy'])('preserves authored boundary failures in %s', async action => {
    const failure = new PluginError({ code: 'credential_unavailable', remediation: { kind: 'retry' } });
    const native = boundary({ failure }), kit = await native.kit();
    const operation = { contributionRef: input.input.launch.provider, schemaVersion: 1, value: { operationId: input.operationId, launch } };
    try {
      await expect(kit.invokeAction(action, action === 'prepare-build' ? input : { nativeOperation: operation }, { surface: 'plugin' })).rejects.toMatchObject({ data: failure.data });
    } finally { await kit.dispose(); }
  });
});
