import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installAgentCliForRuntime } from './install.js';
import type { AgentCliRuntimeDescriptor } from './resolution.js';
import { execFileWithDeadline, ExecFileTerminationError } from '../process/execFileWithDeadline.js';
import { getHappierTempRoot } from '../tempDirs/createHappierTempDir.js';

// Every test runs real executables in a temp HOME; no process boundary is faked.
const posixOnly = process.platform === 'win32' ? it.skip : it;
const platform = process.platform === 'darwin' ? 'darwin' : 'linux';

function vendorSpec(overrides: Partial<AgentCliRuntimeDescriptor> = {}): AgentCliRuntimeDescriptor {
  return {
    id: 'claude',
    title: 'Claude Code CLI',
    binaryName: 'claude',
    sourcePreferenceDefault: 'system-first',
    managedInstall: null,
    manualInstallKind: 'vendor_recipe',
    manualInstallRecipes: {
      darwin: [{ cmd: 'sh', args: ['-c', 'exit 0'] }],
      linux: [{ cmd: 'sh', args: ['-c', 'exit 0'] }],
    },
    acceptsJavaScriptFileOverride: false,
    npmPackageName: '@anthropic-ai/claude-code',
    nativeUpdate: { args: ['update'], installPaths: ['.local/share/claude'] },
    ...overrides,
  };
}

describe('installAgentCliForRuntime intent update (K6)', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'happier-agent-cli-update-install-')));
    env = { ...process.env, HOME: home, HAPPIER_HOME_DIR: join(home, '.happier'), PATH: '/usr/bin:/bin' };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeNativeClaude(): Promise<string> {
    const versionsDir = join(home, '.local', 'share', 'claude', 'versions');
    await mkdir(versionsDir, { recursive: true });
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    const real = join(versionsDir, '2.1.0');
    await writeFile(real, `#!/bin/sh\nif [ "$1" = update ]; then echo updated > "${join(home, 'updated')}"; fi\n`, 'utf8');
    await chmod(real, 0o755);
    const command = join(home, '.local', 'bin', 'claude');
    await symlink(real, command);
    return command;
  }

  posixOnly('runs the declared vendor updater against the exact executable detect reported, only after consent', async () => {
    const command = await writeNativeClaude();
    const updateTarget = { command, source: 'system' as const };

    const refused = await installAgentCliForRuntime({ runtimeSpec: vendorSpec(), platform, env, intent: 'update', updateTarget });
    expect(refused).toMatchObject({ ok: false, errorCode: 'vendor-recipe-disallowed' });

    const result = await installAgentCliForRuntime({
      runtimeSpec: vendorSpec(),
      platform,
      env,
      intent: 'update',
      updateTarget,
      allowVendorRecipeExecution: true,
    });
    expect(result).toMatchObject({ ok: true, alreadyInstalled: false });
    await expect(readFile(join(home, 'updated'), 'utf8')).resolves.toContain('updated');
    if (result.ok) {
      const log = await readFile(result.logPath!, 'utf8');
      expect(log).toContain(`## ${command} update`);
      expect(log).toContain(`Running ${command}`);
    }
  });

  posixOnly('never installs a managed copy beside a package-manager install; names its command instead', async () => {
    const packageDir = join(home, 'prefix', 'lib', 'node_modules', 'opencode-ai');
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(home, 'prefix', 'bin'), { recursive: true });
    await writeFile(join(packageDir, 'bin.js'), '#!/bin/sh\n', 'utf8');
    const command = join(home, 'prefix', 'bin', 'opencode');
    await symlink(join(packageDir, 'bin.js'), command);
    const ensureManagedPnpmCommand = vi.fn(async () => {
      throw new Error('a managed install must not start for an npm-owned CLI');
    });

    const result = await installAgentCliForRuntime({
      runtimeSpec: vendorSpec({
        id: 'opencode',
        binaryName: 'opencode',
        npmPackageName: null,
        nativeUpdate: null,
        manualInstallKind: 'command',
        manualInstallRecipes: null,
        managedInstall: { kind: 'managed_package', packageName: 'opencode-ai', binaryName: 'opencode' },
      }),
      platform,
      env,
      intent: 'update',
      updateTarget: { command, source: 'system' },
      allowVendorRecipeExecution: true,
      deps: { ensureManagedPnpmCommand },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'update-not-available' });
    if (!result.ok) expect(result.errorMessage).toContain('npm install -g opencode-ai@latest');
    expect(ensureManagedPnpmCommand).not.toHaveBeenCalled();
  });

  posixOnly('keeps the event loop free while a vendor command runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 50);
    try {
      const result = await installAgentCliForRuntime({
        runtimeSpec: vendorSpec({
          manualInstallRecipes: {
            darwin: [{ cmd: 'sh', args: ['-c', 'sleep 1'] }],
            linux: [{ cmd: 'sh', args: ['-c', 'sleep 1'] }],
          },
        }),
        platform,
        env,
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
      });
      expect(result.ok).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  posixOnly.each(['install', 'update'] as const)('cancels the running vendor %s and disposes its scratch files', async (intent) => {
    const command = await writeNativeClaude();
    // The finite fixture exits if cancellation is missing, so RED never leaves a real installer running.
    await writeFile(await realpath(command), '#!/bin/sh\nsleep 1\necho completed\n', 'utf8');
    const controller = new AbortController();
    const reason = new Error('installation cancelled by caller');
    const operation = installAgentCliForRuntime({
      runtimeSpec: vendorSpec({ manualInstallRecipes: { [platform]: [{ cmd: command, args: [] }] } }),
      platform,
      env,
      intent,
      ...(intent === 'update' ? { updateTarget: { command, source: 'system' as const } } : {}),
      skipIfInstalled: false,
      allowVendorRecipeExecution: true,
      signal: controller.signal,
      deps: {
        execFileWithDeadline: async (cmd, args, options) => {
          const timer = setTimeout(() => controller.abort(reason), 50);
          try { return await execFileWithDeadline(cmd, args, options); }
          finally { clearTimeout(timer); }
        },
      },
    });
    await expect(operation).rejects.toBe(reason);
    const logDir = join(env.HAPPIER_HOME_DIR!, 'logs', 'agent-installs');
    const [logName] = await readdir(logDir);
    expect(await readFile(join(logDir, logName!), 'utf8')).toContain(reason.message);
    expect(await readdir(getHappierTempRoot(join(env.HAPPIER_HOME_DIR!, 'tools/providers/claude/.tmp')))).toEqual([]);
  });

  posixOnly.each(['install', 'update'] as const)('preserves cancellation when the vendor %s log becomes unavailable', async (intent) => {
    const command = await writeNativeClaude();
    await writeFile(await realpath(command), '#!/bin/sh\nsleep 1\n', 'utf8');
    const controller = new AbortController();
    const reason = new Error('installation cancelled despite unavailable log');
    const operation = installAgentCliForRuntime({
      runtimeSpec: vendorSpec({ manualInstallRecipes: { [platform]: [{ cmd: command, args: [] }] } }),
      platform, env, intent,
      ...(intent === 'update' ? { updateTarget: { command, source: 'system' as const } } : {}),
      skipIfInstalled: false, allowVendorRecipeExecution: true, signal: controller.signal,
      deps: {
        execFileWithDeadline: async (cmd, args, options) => {
          // A real filesystem failure must not replace the owning operation's cancellation.
          await rm(join(env.HAPPIER_HOME_DIR!, 'logs', 'agent-installs'), { recursive: true, force: true });
          const timer = setTimeout(() => controller.abort(reason), 50);
          try { return await execFileWithDeadline(cmd, args, options); }
          finally { clearTimeout(timer); }
        },
      },
    });
    await expect(operation).rejects.toBe(reason);
  });

  posixOnly.each(['install', 'update'] as const)('reports a failed vendor %s termination instead of successful cancellation', async (intent) => {
    const command = await writeNativeClaude();
    const controller = new AbortController();
    const result = await installAgentCliForRuntime({
      runtimeSpec: vendorSpec({ manualInstallRecipes: { [platform]: [{ cmd: command, args: [] }] } }),
      platform, env, intent, skipIfInstalled: false, allowVendorRecipeExecution: true,
      ...(intent === 'update' ? { updateTarget: { command, source: 'system' as const } } : {}),
      signal: controller.signal,
      deps: { execFileWithDeadline: async () => {
        controller.abort();
        throw new ExecFileTerminationError(new Error('fixture process remains live'));
      } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'termination-failed' });
  });
});
