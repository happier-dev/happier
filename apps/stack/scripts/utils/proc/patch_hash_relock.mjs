import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { readLockfilePatchHashes, readWorkspacePatchEntries } from './workspace_package_manifests.mjs';
import { run } from './proc.mjs';

export async function inspectPatchHashDrift({ installDir, inputSnapshot }) {
  const entries = await readWorkspacePatchEntries(installDir);
  const lockedEntries = await readLockfilePatchHashes(installDir);
  const hashes = new Map(lockedEntries);
  if (entries.length === 0 || hashes.size !== entries.length || hashes.size !== lockedEntries.length) return null;
  const lockedInputs = new Map();
  const changed = [];
  for (const [selector, path] of entries) {
    const hash = hashes.get(selector);
    if (!/^[a-f0-9]{64}$/u.test(hash ?? '')) return null;
    const inputPath = `install:${relative(resolve(installDir), resolve(installDir, path)).split(sep).join('/')}`;
    const input = inputSnapshot.find(input => input.path === inputPath);
    if (input?.kind !== 'file') return null;
    lockedInputs.set(inputPath, { ...input, digest: hash });
    if (input.digest !== hash) {
      if (!(await readFile(resolve(installDir, path), 'utf8')).startsWith('diff --git ')) return null;
      changed.push({ selector, path });
    }
  }
  if (changed.length === 0) return null;
  return { changed, lockedInputSnapshot: inputSnapshot.map(input => lockedInputs.get(input.path) ?? input) };
}

async function runPnpm(args, { installDir, env, signal }) {
  // Source-workspace pnpm is already prepared by the installer. Use its
  // existing invocation owner, including the native pnpm/Windows shim path.
  const { resolvePnpmInvocation } = await import('../../../../../scripts/workspaces/execPnpmCommand.mjs');
  const invocation = resolvePnpmInvocation(env.npm_execpath);
  // proc owns Windows command-shim quoting; pass the unresolved invocation so
  // its adapter handles the command exactly once.
  await run(invocation.command, [...invocation.args, ...args], { cwd: installDir, env, signal,
    stdio: 'ignore', captureFailureDiagnostic: true });
}

export async function validateRegisteredPatches({ installDir, env, signal, changed }) {
  const temporary = await mkdtemp(join(tmpdir(), 'hstack-patch-validation-'));
  try {
    for (const [index, { selector }] of changed.entries()) {
      // pnpm extracts the pristine locked package and applies the registered
      // patch by default; neither installed patched bytes nor git decide this.
      await runPnpm(['patch', selector, '--edit-dir', join(temporary, String(index))], { installDir, env, signal });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function relockPatchHashes({ installDir, env, signal, changed }) {
  await runPnpm(['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'], { installDir, env, signal });
  return { patches: changed.map(({ path }) => path), at: new Date().toISOString() };
}
