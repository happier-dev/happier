import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveNpmCommandInvocation, resolvePnpmCommandInvocation } from '../workspaces/execPnpmCommand.mjs';
import { resolveLockedInstallEnv, withDependencyRefreshLock } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';

import { runHostAdmittedTask } from '../../apps/stack/scripts/utils/proc/admission_client.mjs';

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

function installedVersionMatches() {
  try {
    // Query outside the workspace so a different manager cannot switch itself
    // to the declared version and conceal the executable that is installed.
    return run(resolvePnpmCommandInvocation(['--version'], { preferPath: true }), 'pipe', temporaryDir).trim() === version;
  } catch {
    return false;
  }
}

try {
  if (!installedVersionMatches()) {
    // Admission precedes the canonical dependency writer; warm launches need
    // neither the unused archive nor mutation custody.
    await runHostAdmittedTask({ className: 'dependency-install', repoDir }, admittedEnv =>
      withDependencyRefreshLock({ installDir: repoDir, env: admittedEnv }, async context => {
        if (installedVersionMatches()) return;
        const installEnv = resolveLockedInstallEnv(admittedEnv, context);
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
      }));
  }
  console.log(`pnpm ${version} ready`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
