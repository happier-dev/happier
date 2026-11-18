import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveNpmCommandInvocation, resolvePnpmCommandInvocation } from '../workspaces/execPnpmCommand.mjs';

const repoDir = resolve(process.argv[2] ?? process.cwd());
const { packageManager } = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
const pin = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([a-f0-9]{128})$/i.exec(packageManager ?? '');
if (!pin) throw new Error('Root packageManager must pin an exact pnpm version with SHA512 integrity');
const [, version, integrity] = pin;
const temporaryDir = mkdtempSync(join(tmpdir(), 'happier-setup-pnpm-'));

function run(invocation, stdio = 'inherit', cwd = repoDir, env = process.env) {
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio,
    encoding: 'utf8',
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

const darwinSwitchDir = process.platform === 'darwin'
  ? join(process.env.PNPM_HOME || (process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, 'pnpm')
    : join(homedir(), 'Library', 'pnpm')), '.tools', 'pnpm', version)
  : undefined;

function executableMatches(invocation) {
  try {
    // Query outside the workspace so a different manager cannot switch itself
    // to the declared version and conceal the executable that is installed.
    return run(invocation, 'pipe', temporaryDir).trim() === version;
  } catch {
    return false;
  }
}

function installedVersionMatches() {
  return executableMatches(resolvePnpmCommandInvocation(['--version'], { preferPath: true }));
}

function darwinSwitchNeedsRepair() {
  if (!darwinSwitchDir || !lstatSync(darwinSwitchDir, { throwIfNoEntry: false })) return false;
  return !executableMatches({ command: join(darwinSwitchDir, 'bin', 'pnpm'), args: ['--version'] });
}

function repairDarwinSwitch(installEnv) {
  // pnpm 10 publishes the selected version as a symlink to its staged
  // package, but skips install scripts. Run pnpm's own atomic native
  // promotion for that published package. Ignore unreferenced stages.
  const wrapper = join(darwinSwitchDir, 'node_modules', 'pnpm');
  const manifest = JSON.parse(readFileSync(join(wrapper, 'package.json'), 'utf8'));
  if (manifest.name !== 'pnpm' || manifest.version !== version) {
    throw new Error(`Expected pnpm ${version} in the published Darwin switch cache`);
  }
  run({ command: process.execPath, args: [join(wrapper, 'install.js')] }, 'inherit', wrapper, {
    ...installEnv, npm_lifecycle_event: 'preinstall',
  });
  if (darwinSwitchNeedsRepair()) throw new Error(`Expected executable pnpm ${version} in the Darwin switch cache`);
}

try {
  if (darwinSwitchNeedsRepair() || !installedVersionMatches()) {
    const preparePinnedPnpm = installEnv => {
      if (darwinSwitchNeedsRepair()) repairDarwinSwitch(installEnv);
      if (installedVersionMatches()) return;
      // npm ships with Node even where Corepack does not (Node 25+). Verify
      // the registry archive against the root pin before installing it.
      const packed = JSON.parse(run(resolveNpmCommandInvocation([
        'pack', `pnpm@${version}`, '--ignore-scripts', '--json', '--pack-destination', temporaryDir,
      ], { npmExecPath: process.env.npm_execpath }), 'pipe', repoDir, installEnv));
      const archivePath = join(temporaryDir, packed[0].filename);
      const actualIntegrity = createHash('sha512').update(readFileSync(archivePath)).digest('hex');
      if (actualIntegrity !== integrity.toLowerCase()) throw new Error('pnpm archive integrity mismatch');
      run(resolveNpmCommandInvocation(['install', '--global', archivePath], { npmExecPath: process.env.npm_execpath }), 'inherit', repoDir, installEnv);
      if (!installedVersionMatches()) throw new Error(`Expected installed pnpm ${version}`);
    };

    // Docker deps stages carry only the pin installer and its workspace command
    // adapter. Full checkouts retain host admission and dependency-refresh custody.
    const dependencyRefreshUrl = new URL('../../apps/stack/scripts/utils/proc/dependency_refresh.mjs', import.meta.url);
    if (existsSync(dependencyRefreshUrl)) {
      const { resolveLockedInstallEnv, withDependencyRefreshLock } = await import(dependencyRefreshUrl.href);
      const { runHostAdmittedTask } = await import('../../apps/stack/scripts/utils/proc/admission_client.mjs');
      // Admission precedes the canonical dependency writer; warm launches need
      // neither the unused archive nor mutation custody.
      await runHostAdmittedTask({ className: 'dependency-install', repoDir }, admittedEnv =>
        withDependencyRefreshLock({ installDir: repoDir, env: admittedEnv }, async context =>
          preparePinnedPnpm(resolveLockedInstallEnv(admittedEnv, context))));
    } else {
      preparePinnedPnpm(process.env);
    }
  }
  console.log(`pnpm ${version} ready`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
