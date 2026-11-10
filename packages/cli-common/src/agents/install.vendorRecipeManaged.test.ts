import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installAgentCliForRuntime, planAgentCliInstallForRuntime } from './install.js';
import {
  resolveAgentCliCommandForRuntime,
  resolveAgentCliManagedCommandPathForRuntime,
  type AgentCliRuntimeDescriptor,
} from './resolution.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-vendor-'));
  const home = join(root, 'person');
  const command = join(root, 'vendor-installer');
  await mkdir(home);
  await writeFile(command, '#!/bin/sh\nexit 0\n');
  await chmod(command, 0o755);
  const runtimeSpec: AgentCliRuntimeDescriptor = {
    id: 'fixture-vendor', title: 'Fixture vendor', binaryName: 'fixture',
    sourcePreferenceDefault: 'system-first', acceptsJavaScriptFileOverride: false,
    managedInstall: {
      kind: 'vendor_recipe', binaryName: 'fixture', installDirEnvKey: 'FIXTURE_INSTALL_DIR',
      env: { FIXTURE_NO_MODIFY_PATH: '1' },
    },
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: { linux: [{ cmd: command, args: ['install'] }] },
  };
  const env = { HOME: home, HAPPIER_HOME_DIR: join(root, 'happier'), PATH: '',
    XDG_CONFIG_HOME: join(home, 'config'), ZDOTDIR: home,
    HAPPIER_FIXTURE_VENDOR_PATH: command, FIXTURE_INSTALL_DIR: home };
  const currentCommand = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv: env });
  const binaryBasename = process.platform === 'win32' ? 'fixture.cmd' : 'fixture';
  return { root, home, command, runtimeSpec, env, currentCommand, binaryBasename };
}

async function writeExecutable(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

describe('managed vendor recipes through the existing install owner', () => {
  it('requires existing vendor consent even under the managed-only policy', async () => {
    const f = await fixture();
    try {
      const result = await installAgentCliForRuntime({ runtimeSpec: f.runtimeSpec, platform: 'linux',
        env: f.env, sourcePolicy: 'managed_only', skipIfInstalled: false,
        deps: { execFileWithDeadline: async () => { throw new Error('Unconsented execution'); } } });
      expect(result).toMatchObject({ ok: false, errorCode: 'vendor-recipe-disallowed', logPath: null });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('runs the declared recipe in scratch, promotes all launcher files, and resolves only managed code', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.home, '.profile'), 'person profile');
      let executions = 0;
      const result = await installAgentCliForRuntime({ runtimeSpec: f.runtimeSpec, platform: 'linux',
        env: f.env, sourcePolicy: 'managed_only', allowVendorRecipeExecution: true,
        deps: {
          // OS execution is the boundary; admission, recipe execution and promotion stay real.
          execFileWithDeadline: async (command, args, options) => {
            executions++;
            expect(command).toBe(f.command);
            expect(args).toEqual(['install']);
            const childEnv = options.env!;
            expect(childEnv.FIXTURE_NO_MODIFY_PATH).toBe('1');
            expect(childEnv.HOME).not.toBe(f.home);
            expect(childEnv.XDG_CONFIG_HOME).not.toBe(f.env.XDG_CONFIG_HOME);
            expect(childEnv.ZDOTDIR).not.toBe(f.home);
            const installDir = childEnv.FIXTURE_INSTALL_DIR!;
            expect(installDir).not.toBe(dirname(f.currentCommand));
            await writeExecutable(join(installDir, f.binaryBasename), '#!/bin/sh\necho fixture\n');
            await writeFile(join(installDir, '.vendor-launcher'), 'relative launcher support');
            await writeFile(join(childEnv.HOME!, '.profile'), 'installer profile');
            return { stdout: '', stderr: '' };
          },
        } });
      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      expect(executions).toBe(1);
      expect(await readFile(f.currentCommand, 'utf8')).toContain('echo fixture');
      expect(await readFile(join(dirname(f.currentCommand), '.vendor-launcher'), 'utf8')).toBe('relative launcher support');
      expect(await readFile(join(f.home, '.profile'), 'utf8')).toBe('person profile');
      expect(f.env.FIXTURE_INSTALL_DIR).toBe(f.home);
      expect(resolveAgentCliCommandForRuntime(f.runtimeSpec, { processEnv: f.env, sourcePolicy: 'managed_only' }))
        .toMatchObject({ source: 'managed', command: f.currentCommand });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(['nonzero', 'missing-executable', 'cancelled'] as const)(
    'preserves the prior current install when the vendor candidate is %s', async failure => {
      const f = await fixture();
      const controller = new AbortController();
      try {
        await writeExecutable(f.currentCommand, '#!/bin/sh\necho prior\n');
        const install = installAgentCliForRuntime({ runtimeSpec: f.runtimeSpec, platform: 'linux',
          env: f.env, sourcePolicy: 'managed_only', allowVendorRecipeExecution: true,
          intent: 'update', signal: controller.signal,
          deps: { execFileWithDeadline: async (_command, _args, options) => {
            if (failure !== 'missing-executable') {
              await writeExecutable(join(options.env!.FIXTURE_INSTALL_DIR!, f.binaryBasename), '#!/bin/sh\necho candidate\n');
            }
            if (failure === 'cancelled') controller.abort(new Error('Person cancelled install'));
            if (failure === 'nonzero') throw Object.assign(new Error('Vendor refused'), { code: 1, stderr: 'Vendor refused' });
            return { stdout: '', stderr: '' };
          } } });
        if (failure === 'cancelled') await expect(install).rejects.toThrow('Person cancelled install');
        else expect(await install).toMatchObject({ ok: false, errorCode: 'command-failed' });
        expect(await readFile(f.currentCommand, 'utf8')).toContain('echo prior');
      } finally { await rm(f.root, { recursive: true, force: true }); }
    },
  );

  it('does not advertise a managed recipe on a platform with no declared commands', async () => {
    const f = await fixture();
    try {
      expect(planAgentCliInstallForRuntime({ runtimeSpec: f.runtimeSpec, platform: 'win32' }))
        .toMatchObject({ ok: false, errorCode: 'no-recipe' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
