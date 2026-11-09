import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import * as fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, createEmptyMachineSetupDesiredV1, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createMachineSetupPlanAction } from './machineSetupAction';

// Only kernel and init filesystem reads are substituted. Plugin admission,
// projection, selection, package observation and plan reduction remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => vi.restoreAllMocks());

it('plans the real emulation declaration package-first, refuses unsupported fallback and leaves native support untouched', async () => {
  const source = fileURLToPath(new URL('../../../../../packages/plugins/machine-recipes/src/binfmtQemu.ts', import.meta.url));
  const { binfmtQemu } = await import(pathToFileURL(source).href);
  const pluginId = 'happier.machine.recipes';
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: {
    schemaVersion: 2, id: pluginId, version: '0.0.0', displayName: 'Machine recipes', runtime: { apiVersion: 1 },
    contributes: { machineRecipes: [{ id: 'binfmt-qemu', ...binfmtQemu }] },
  } }] });
  let packageAvailable = true;
  const calls: string[] = [];
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === '/proc/1/comm') return Buffer.from('systemd\n');
    if (String(args[0]).startsWith('/proc/sys/fs/binfmt_misc/')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return actualFs.readFile(...args);
  });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const execute = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({
    homeId: 'home', machineId: 'builder',
    apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Plan cannot write desired setup'); },
    }) },
    acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
      controller: runtime.controller, happyHomeDir: runtime.happyHomeDir,
    }),
    runNative: async command => {
      calls.push(command.executable);
      if (command.executable === 'uname') return ok('x86_64\n');
      if (command.executable === 'systemctl' && command.args[0] === 'show') return ok('LoadState=loaded\nUnitFileState=static\n');
      if (command.executable === 'dpkg') return ok('amd64\n');
      if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6\n');
      if (command.executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
      if (command.executable === 'lslocks') return ok('{"locks":[]}');
      if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
        ? `qemu-user-static:\n  Candidate: ${packageAvailable ? '1' : '(none)'}\n  Version table:\n     1 500\n`
        : 'Package: qemu-user-static\nVersion: 1\nArchitecture: amd64\n\n');
      throw new Error('Read-only Plan must never mutate native registration or install');
    },
  }) });
  const plan = (architectures: string[]) => execute.execute('machines.setup.plan', { homeId: 'home', machineId: 'builder', sources: [
    { kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
      ref: { pluginId, recipeId: 'binfmt-qemu', revision: '1' }, inputs: { manager: 'apt', architectures },
    } }] } },
  ] }, { surface: 'cli', authority: 'present_user' });
  try {
    expect(await plan(['amd64'])).toMatchObject({ ok: true, result: { support: [{ status: 'satisfied' }],
      recipePlans: [{ plan: { steps: [], checks: [{ id: 'requested-emulation' }] } }] } });
    expect(calls).toEqual(['uname']);
    calls.length = 0;
    expect(await plan(['arm64'])).toMatchObject({ ok: true, result: { support: [{ status: 'drifted' }],
      recipePlans: [{ plan: { steps: [{ id: 'distro-package', kind: 'package' },
        { id: 'register-apt-arm64', kind: 'command', args: ['qemu-aarch64.conf'] }] } }] } });
    expect(calls).not.toContain('/usr/lib/systemd/systemd-binfmt');
    packageAvailable = false;
    expect(await plan(['arm64'])).toMatchObject({ ok: true, result: { support: [{ status: 'unsupported' }],
      recipePlans: [{ plan: { steps: [], checkFacts: [{ status: 'drifted' }, { status: 'unsupported' }] } }] } });
  } finally { await runtime.dispose(); }
});
